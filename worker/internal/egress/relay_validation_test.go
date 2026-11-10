package egress

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

func TestSpliceIdleClosesBidirectionalBackpressure(t *testing.T) {
	leftClient, leftRelay := net.Pipe()
	rightClient, rightRelay := net.Pipe()
	defer leftClient.Close()
	defer rightClient.Close()
	defer leftRelay.Close()
	defer rightRelay.Close()
	done := make(chan error, 1)
	go func() { done <- spliceIdle(leftRelay, rightRelay, "offline.test:443", 40*time.Millisecond) }()
	writes := make(chan error, 2)
	go func() { _, err := leftClient.Write([]byte("left")); writes <- err }()
	go func() { _, err := rightClient.Write([]byte("right")); writes <- err }()
	for range 2 {
		select {
		case err := <-writes:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("fixture did not write into relay")
		}
	}
	// Both reads completed, but neither peer reads the forwarded data.
	select {
	case err := <-done:
		var se *spliceError
		if !errors.As(err, &se) || se.class != classIdleClose {
			t.Fatalf("expected idle close, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("relay remained blocked in Write after the idle deadline")
	}
}

func TestResolveDNSValidatesRepliesBeforeChoosingUpstream(t *testing.T) {
	query := overrideQuery(t, 1)
	for _, tc := range []struct {
		name     string
		change   func(*dnsmessage.Message)
		raw      []byte
		fallback bool
	}{
		{name: "malformed", raw: []byte("invalid-dns-body"), fallback: true},
		{name: "oversized", raw: make([]byte, 65536), fallback: true},
		{name: "query-instead-of-response", change: func(m *dnsmessage.Message) { m.Response = false }, fallback: true},
		{name: "different-id", change: func(m *dnsmessage.Message) { m.ID++ }, fallback: true},
		{name: "different-opcode", change: func(m *dnsmessage.Message) { m.OpCode++ }, fallback: true},
		{name: "missing-question", change: func(m *dnsmessage.Message) { m.Questions = nil }, fallback: true},
		{name: "different-name", change: func(m *dnsmessage.Message) {
			m.Questions[0].Name = dnsmessage.MustNewName("other.example.")
		}, fallback: true},
		{name: "different-type", change: func(m *dnsmessage.Message) { m.Questions[0].Type = dnsmessage.TypeAAAA }, fallback: true},
		{name: "different-class", change: func(m *dnsmessage.Message) { m.Questions[0].Class++ }, fallback: true},
		{name: "matching"},
		{name: "case-insensitive-name", change: func(m *dnsmessage.Message) {
			m.Questions[0].Name = dnsmessage.MustNewName("EXAMPLE.COM.")
		}},
		{name: "servfail", change: func(m *dnsmessage.Message) { m.RCode = dnsmessage.RCodeServerFailure }},
		{name: "nxdomain", change: func(m *dnsmessage.Message) { m.RCode = dnsmessage.RCodeNameError }},
		{name: "servfail-without-question", change: func(m *dnsmessage.Message) {
			m.RCode = dnsmessage.RCodeServerFailure
			m.Questions = nil
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var msg dnsmessage.Message
			if err := msg.Unpack(query); err != nil {
				t.Fatal(err)
			}
			msg.Response = true
			valid, err := msg.Pack()
			if err != nil {
				t.Fatal(err)
			}
			if tc.change != nil {
				tc.change(&msg)
			}
			first, err := msg.Pack()
			if err != nil {
				t.Fatal(err)
			}
			if tc.raw != nil {
				first = tc.raw
			}
			var fallbackHits atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/first" {
					_, _ = w.Write(first)
					return
				}
				fallbackHits.Add(1)
				_, _ = w.Write(valid)
			}))
			defer upstream.Close()
			srv := &Server{http: upstream.Client(), upstreams: []string{upstream.URL + "/first", upstream.URL + "/fallback"}}
			got, err := srv.ResolveDNS(context.Background(), query)
			if err != nil {
				t.Fatal(err)
			}
			want, wantHits := first, int32(0)
			if tc.fallback {
				want, wantHits = valid, 1
			}
			if !bytes.Equal(got, want) || fallbackHits.Load() != wantHits || srv.preferred.Load() != wantHits {
				t.Fatalf("reply=%x fallback hits=%d preferred=%d; want reply=%x fallback=%d", got, fallbackHits.Load(), srv.preferred.Load(), want, wantHits)
			}
		})
	}
}

func TestResolveDNSRejectsMalformedTCPReplyBeforeFallback(t *testing.T) {
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		conn, err := upstream.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		var size [2]byte
		if _, err := io.ReadFull(conn, size[:]); err != nil {
			return
		}
		if _, err := io.CopyN(io.Discard, conn, int64(binary.BigEndian.Uint16(size[:]))); err != nil {
			return
		}
		body := []byte("invalid-dns-body")
		frame := make([]byte, 2+len(body))
		binary.BigEndian.PutUint16(frame, uint16(len(body)))
		copy(frame[2:], body)
		_, _ = conn.Write(frame)
	}()
	socks, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socks.Close()
	go serveTestSOCKS(t, socks)
	query := overrideQuery(t, 1)
	valid := bytes.Clone(query)
	valid[2] |= 0x80
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(valid) }))
	defer fallback.Close()
	srv, err := New(Config{ProxyURL: "socks5h://" + socks.Addr().String(), ListenTCP: "127.0.0.1:0",
		DNSUpstream: upstream.Addr().String() + "," + fallback.URL})
	if err != nil {
		t.Fatal(err)
	}
	srv.http = fallback.Client()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	got, err := srv.ResolveDNS(ctx, query)
	if err != nil || !bytes.Equal(got, valid) || srv.preferred.Load() != 1 {
		t.Fatalf("reply=%x preferred=%d err=%v", got, srv.preferred.Load(), err)
	}
}
