import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "../..");
const webRequire = createRequire(path.join(root, "web/package.json"));
const { createServer } = await import(
  pathToFileURL(webRequire.resolve("vite"))
);
const { default: react } = await import(
  pathToFileURL(webRequire.resolve("@vitejs/plugin-react"))
);
const { default: tailwindcss } = await import(
  pathToFileURL(webRequire.resolve("@tailwindcss/vite"))
);
const fixture = fileURLToPath(
  new URL("./scheduling-fixture.tsx", import.meta.url),
).replaceAll("\\", "/");

test(
  "list scheduling sits below usage and saves exact independent changes",
  { timeout: 90_000 },
  async (t) => {
    assert.ok(
      process.env.UI_BROWSER_EXE,
      "UI_BROWSER_EXE must point to an installed test Chromium",
    );
    const vite = await createServer({
      configFile: false,
      root: path.join(root, "web"),
      cacheDir: path.join(root, "web/node_modules/.vite-scheduling-fixture"),
      plugins: [
        react(),
        tailwindcss(),
        {
          name: "offline-scheduling-fixture",
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              if (new URL(req.url, "http://fixture").pathname !== "/offline-ui")
                return next();
              const html = await server.transformIndexHtml(
                "/offline-ui",
                `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Offline scheduling</title></head><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`,
              );
              res.setHeader("content-type", "text/html");
              res.end(html);
            });
          },
        },
      ],
      resolve: {
        alias: { "@": path.join(root, "web/src") },
        dedupe: [
          "react",
          "react-dom",
          "@tanstack/react-query",
          "@tanstack/react-router",
        ],
      },
      server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
      optimizeDeps: { entries: [fixture] },
    });
    let browser;
    t.after(async () => {
      await browser?.close();
      await vite.close();
    });
    await vite.listen();
    const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
    browser = await chromium.launch({
      executablePath: process.env.UI_BROWSER_EXE,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const rejectedOrigins = [];
    const errors = [];
    const writes = [];
    const switchWrites = [];
    const healthRequests = [];
    let rejectHealth = false;
    let role = "admin";
    let releasePending;
    let delayNext = false;
    let rejectNext = false;
    const vm = {
      id: "offline-slot",
      name: "测试槽",
      platform: "openai",
      family: "codex",
      status: "running",
      schedulable: false,
      schedule_state: "off",
      inflight: 3,
      schedule_level: 6,
      schedule_level_mode: "auto",
      has_token: true,
      email: "offline@example.test",
      reset_7d: "2026-11-21T01:00:00Z",
      utilization_5h: 0.42,
      utilization_7d: 0.18,
      codex_usage: {
        pending_refresh: true,
        last_success_at: "2026-11-16T07:00:00Z",
      },
      codex_credits: { status: "available", balance: 12.5 },
      openai_api: {
        has_key: true,
        balance: "25.50",
        balance_refresh_interval_minutes: 0,
      },
      health_24h: Array.from({ length: 48 }, (_, i) =>
        i === 47 ? [99, 1] : [0, 0],
      ),
    };
    const visualRows = [
      {
        id: "offline-auto1",
        name: "自动 1",
        schedule_level: 1,
        schedule_level_mode: "auto",
      },
      {
        id: "offline-manual6",
        name: "手动 6",
        schedule_level: 6,
        schedule_level_mode: "manual",
      },
      {
        id: "offline-manual10",
        name: "手动 10",
        schedule_level: 10,
        schedule_level_mode: "manual",
      },
    ].map((row) => ({
      ...vm,
      ...row,
      email: `${row.id}@example.test`,
      schedulable: true,
      schedule_state: "on",
      health_24h:
        row.id === "offline-manual6"
          ? null
          : row.id === "offline-manual10"
            ? undefined
            : vm.health_24h,
    }));
    const liveRows = [
      {
        ...vm,
        id: "offline-available-codex",
        name: "可用 Codex",
        schedulable: true,
        schedule_state: "on",
        availability: { key: "ok", text: "可用", usable: true },
        proxy: {
          id: "offline-proxy",
          host: "192.0.2.1",
          port: 1080,
          status: "ok",
          latency_ms: 12,
        },
      },
      {
        ...vm,
        id: "offline-claude-seats",
        name: "Claude 席位",
        platform: "anthropic",
        family: "claude",
        schedulable: true,
        schedule_state: "on",
        availability: { key: "ok", text: "可用", usable: true },
        inflight: 0,
        seats_max: 5,
        seats_used: 2,
        queue_depth: 1,
      },
    ];
    const allRows = [vm, ...visualRows, ...liveRows];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        rejectedOrigins.push(url.origin);
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/panel/me")
        return route.fulfill({
          json: { ok: true, data: { user: "offline", role } },
        });
      if (url.pathname === "/api/panel/vms" && request.method() === "GET") {
        return route.fulfill({
          json: { ok: true, data: { items: allRows } },
        });
      }
      if (url.pathname.endsWith("/health")) {
        assert.equal(request.method(), "GET");
        const range = url.searchParams.get("range");
        assert.ok(range === "24h" || range === "7d");
        healthRequests.push({ role, path: url.pathname, range });
        if (rejectHealth) {
          rejectHealth = false;
          return route.fulfill({
            status: 503,
            json: { ok: false, error: { message: "离线健康查询失败" } },
          });
        }
        const sample = allRows.find(
          (item) => url.pathname === `/api/panel/vms/${item.id}/health`,
        );
        return route.fulfill({
          json: {
            ok: true,
            data: {
              range,
              slot_min: range === "7d" ? 120 : 30,
              start: "2026-11-15T08:00:00Z",
              buckets: sample.health_24h,
              top_errors: sample.health_24h
                ? [
                    {
                      code: "offline_error",
                      status: 502,
                      count: 1,
                      last_at: "2026-11-16T07:00:00Z",
                    },
                  ]
                : [],
            },
          },
        });
      }
      if (url.pathname === "/api/panel/vms/offline-slot/schedulable") {
        assert.equal(request.method(), "POST");
        const body = request.postDataJSON();
        assert.deepEqual(Object.keys(body), ["schedulable"]);
        switchWrites.push(body);
        vm.schedulable = body.schedulable;
        vm.schedule_state = body.schedulable ? "on" : "off";
        return route.fulfill({ json: { ok: true, data: { vm } } });
      }
      assert.equal(url.pathname, "/api/panel/vms/offline-slot");
      assert.equal(request.method(), "PATCH");
      const body = request.postDataJSON();
      writes.push(body);
      if (delayNext) {
        delayNext = false;
        await new Promise((resolve) => {
          releasePending = resolve;
        });
      }
      if (rejectNext) {
        rejectNext = false;
        return route.fulfill({
          status: 409,
          json: { ok: false, error: { message: "离线测试拒绝" } },
        });
      }
      assert.deepEqual(Object.keys(body), ["schedule_level"]);
      vm.schedule_level_mode =
        body.schedule_level === "auto" ? "auto" : "manual";
      vm.schedule_level =
        body.schedule_level === "auto" ? 4 : body.schedule_level;
      return route.fulfill({ json: { ok: true, data: { vm } } });
    });
    await context.addInitScript(() => {
      localStorage.setItem("kin_console_token", "offline-scheduling-token");
      localStorage.setItem(
        "kin.vm.column-order",
        JSON.stringify([
          "vm",
          "type",
          "sched",
          "status",
          "req",
          "usage",
          "cost",
        ]),
      );
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/offline-ui`);
    const bar = page.getByRole("group", {
      name: "offline-slot 调度优先级",
      exact: true,
    });
    const block = (n) =>
      bar.getByRole("button", {
        name: `offline-slot 调度优先级 ${n}`,
        exact: true,
      });
    const auto = page.getByRole("button", {
      name: "offline-slot 自动调度优先级",
      exact: true,
    });
    await block(6).waitFor();
    assert.equal(await page.getByLabel(/额度待刷新/).count(), 0);
    assert.equal(await bar.getByRole("button").count(), 11);
    assert.equal(await auto.innerText(), "");
    assert.equal(await page.getByText("调度", { exact: true }).count(), 0);
    assert.equal(await page.getByText("用量窗口", { exact: true }).count(), 1);
    for (let n = 1; n <= 10; n++) assert.equal(await block(n).innerText(), "");
    const manualButtons = bar.getByRole("button", {
      name: /^offline-slot 调度优先级 \d+$/,
    });
    const boxes = await manualButtons.evaluateAll((buttons) =>
      buttons.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, width: r.width, height: r.height };
      }),
    );
    assert.ok(boxes.every((b) => b.width >= 24 && b.height >= 24));
    for (let n = 1; n < boxes.length; n++)
      assert.ok(Math.abs(boxes[n].x - boxes[n - 1].x - boxes[n - 1].width) < 1);
    const geometry = await bar.evaluate((el) => {
      const buttons = [...el.querySelectorAll("button")].filter((button) =>
        button.querySelector('[data-slot="priority-segment"]'),
      );
      const segments = buttons.map((button) =>
        button.querySelector('[data-slot="priority-segment"]'),
      );
      const rect = el.getBoundingClientRect();
      const controls = el.parentElement;
      const cell = controls.closest('[data-slot="vm-usage-cell"]');
      const windows = cell.firstElementChild.getBoundingClientRect();
      const toggle = controls.querySelector('[role="switch"]').getBoundingClientRect();
      const automatic = el.querySelector('button').getBoundingClientRect();
      const automaticSegment = el.querySelector('[data-slot="priority-auto-segment"]').getBoundingClientRect();
      const firstManual = buttons[0].getBoundingClientRect();
      return {
        width: rect.width,
        cellWidth: cell.getBoundingClientRect().width,
        belowWindows: controls.getBoundingClientRect().top >= windows.bottom,
        switchCenter: toggle.top + toggle.height / 2,
        barCenter: rect.top + rect.height / 2,
        switchBeforeBar: toggle.right < rect.left,
        automaticGap: firstManual.left - automatic.right,
        automaticHeight: automaticSegment.height,
        automaticTop: automaticSegment.top,
        manualTop: buttons[0].querySelector('[data-slot="priority-segment"]').getBoundingClientRect().top,
        segments: segments.map((segment, index) => ({
          width: segment.getBoundingClientRect().width,
          height: segment.getBoundingClientRect().height,
          top:
            segment.getBoundingClientRect().top -
            buttons[index].getBoundingClientRect().top,
          divider: getComputedStyle(segment).borderRightWidth,
        })),
        backgrounds: buttons.map(
          (button) => getComputedStyle(button).backgroundColor,
        ),
      };
    });
    assert.equal(geometry.width, 268);
    assert.ok(geometry.cellWidth >= 308);
    assert.equal(geometry.belowWindows, true);
    assert.equal(geometry.switchBeforeBar, true);
    assert.ok(Math.abs(geometry.switchCenter - geometry.barCenter) < 1);
    assert.equal(geometry.automaticGap, 4);
    assert.equal(geometry.automaticHeight, 6);
    assert.equal(geometry.automaticTop, geometry.manualTop);
    assert.ok(
      geometry.segments.every(
        (segment) =>
          segment.width === 24 && segment.height === 6 && segment.top === 9,
      ),
    );
    assert.deepEqual(
      geometry.segments.map((segment) => segment.divider),
      Array(9).fill("1px").concat("0px"),
    );
    assert.ok(
      geometry.backgrounds.every((color) => color === "rgba(0, 0, 0, 0)"),
    );
    await block(6).hover();
    assert.equal(
      await block(6).evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgba(0, 0, 0, 0)",
    );

    const visualRow = page.locator("[data-vm-row]").filter({
      has: page.getByRole("group", {
        name: "offline-auto1 调度优先级",
        exact: true,
      }),
    });
    const visualBar = visualRow.getByRole("group", {
      name: "offline-auto1 调度优先级",
      exact: true,
    });
    const sla = visualRow.getByRole("img", { name: /近 24h 请求健康/ });
    const slaGeometry = await sla.evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      height: el.getBoundingClientRect().height,
      slots: el.children.length,
    }));
    assert.deepEqual(slaGeometry, { width: 104, height: 12, slots: 48 });
    const automaticColor = await visualBar
      .locator('[data-slot="priority-segment"]')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const manualColor = await page
      .getByRole("group", { name: "offline-manual6 调度优先级", exact: true })
      .locator('[data-slot="priority-segment"]')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(manualColor, automaticColor);
    for (const id of ["offline-auto1", "offline-manual6", "offline-manual10"]) {
      const priority = page.getByRole("group", {
        name: `${id} 调度优先级`,
        exact: true,
      });
      assert.equal(await priority.locator("..").innerText(), "");
    }
    const availableRow = page.locator("[data-vm-row]").filter({
      has: page.getByRole("group", {
        name: "offline-available-codex 调度优先级",
        exact: true,
      }),
    });
    const claudeRow = page.locator("[data-vm-row]").filter({
      has: page.getByRole("group", {
        name: "offline-claude-seats 调度优先级",
        exact: true,
      }),
    });
    const available = availableRow.getByText("可用", { exact: true });
    const inflight = availableRow.locator('[title="在飞 3"]');
    const seats = claudeRow.getByText("席位 2/5 · 排队 1", { exact: true });
    const liveHealth = availableRow.getByRole("img", {
      name: "近 24h 请求健康：99/100 成功",
      exact: true,
    });
    const livePercentage = availableRow.getByText("99.0%", { exact: true });
    const liveSummary = availableRow.getByText("99/100 成功", { exact: true });
    const liveProxy = availableRow.locator('[title*="点击探测出口"]');
    await available.waitFor();
    assert.equal(await inflight.innerText(), "3");
    assert.equal(await seats.count(), 1);
    assert.equal(
      await bar.locator("xpath=ancestor::*[@data-vm-row]")
        .locator('[title="在飞 3"]').count(),
      0,
      "a manually disabled row keeps its inflight badge hidden",
    );
    await page.getByRole("button", { name: "配置状态栏显示", exact: true }).click();
    const statusOption = page.getByRole("menuitemcheckbox", {
      name: "状态", exact: true,
    });
    const healthOption = page.getByRole("menuitemcheckbox", {
      name: "健康", exact: true,
    });
    const proxyOption = page.getByRole("menuitemcheckbox", {
      name: "代理", exact: true,
    });
    for (const option of [statusOption, healthOption, proxyOption])
      assert.equal(await option.getAttribute("aria-checked"), "true");
    await statusOption.click();
    await available.waitFor({ state: "hidden" });
    assert.equal(await inflight.count(), 0);
    assert.equal(await seats.count(), 0);
    assert.equal(await liveHealth.count(), 1);
    assert.equal(await livePercentage.count(), 1);
    assert.equal(await liveSummary.count(), 1);
    assert.equal(await liveProxy.count(), 1);
    await statusOption.click();
    await available.waitFor();
    await healthOption.click();
    await liveHealth.waitFor({ state: "hidden" });
    assert.equal(await livePercentage.count(), 0);
    assert.equal(await liveSummary.count(), 0);
    assert.equal(await inflight.count(), 1);
    assert.equal(await seats.count(), 1);
    assert.equal(await liveProxy.count(), 1);
    await healthOption.click();
    await liveHealth.waitFor();
    await proxyOption.click();
    await liveProxy.waitFor({ state: "hidden" });
    assert.equal(await available.count(), 1);
    assert.equal(await inflight.count(), 1);
    assert.equal(await seats.count(), 1);
    assert.equal(await liveHealth.count(), 1);
    await proxyOption.click();
    await liveProxy.waitFor();
    await page.keyboard.press("Escape");
    assert.deepEqual(writes, [], "display options never modify a slot");
    assert.deepEqual(healthRequests, [], "display options never query a kernel");
    const screenshots = path.join(root, ".tmp/11705-ui");
    fs.mkdirSync(screenshots, { recursive: true });
    await availableRow.scrollIntoViewIfNeeded();
    await claudeRow.scrollIntoViewIfNeeded();
    const availableBounds = await availableRow.boundingBox();
    const claudeBounds = await claudeRow.boundingBox();
    await page.screenshot({
      path: path.join(screenshots, "usage-scheduling-rows.png"),
      clip: {
        x: availableBounds.x,
        y: availableBounds.y,
        width: Math.min(availableBounds.width, 1440 - availableBounds.x),
        height: claudeBounds.y + claudeBounds.height - availableBounds.y,
      },
    });
    await block(6).focus();
    await page
      .getByRole("tooltip", {
        name: "自动调度优先级，当前等级 6；设为手动 6",
        exact: true,
      })
      .waitFor();
    const focused = await block(6).evaluate((el) => ({
      active: el === document.activeElement,
      outline: getComputedStyle(el).outlineStyle,
    }));
    assert.deepEqual(focused, { active: true, outline: "solid" });
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        document
          .querySelector('[aria-label="offline-slot 调度优先级 6"]')
          ?.getAttribute("aria-pressed") === "true",
    );
    assert.deepEqual(writes, [{ schedule_level: 6 }]);
    assert.equal(vm.schedulable, false);
    await block(6).click();
    assert.equal(writes.length, 1);
    await auto.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(
      () =>
        document
          .querySelector('[aria-label="offline-slot 自动调度优先级"]')
          ?.getAttribute("aria-pressed") === "true",
    );
    assert.deepEqual(writes.at(-1), { schedule_level: "auto" });
    await auto.click();
    assert.equal(writes.length, 2);
    delayNext = true;
    await block(8).evaluate((el) => {
      el.click();
      el.click();
    });
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="offline-slot 调度优先级 8"]')
          ?.disabled,
    );
    assert.equal(writes.length, 3);
    assert.deepEqual(writes.at(-1), { schedule_level: 8 });
    assert.equal(await auto.isDisabled(), true);
    await auto.evaluate((el) => el.click());
    assert.equal(writes.length, 3);
    await block(10).evaluate((el) => el.click());
    assert.equal(writes.length, 3);
    releasePending();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[aria-label="offline-slot 调度优先级 8"]')
          ?.getAttribute("aria-pressed") === "true",
    );
    rejectNext = true;
    await block(9).click();
    await page.getByText("离线测试拒绝", { exact: true }).waitFor();
    assert.equal(await block(8).getAttribute("aria-pressed"), "true");
    assert.equal(await block(9).getAttribute("aria-pressed"), "false");
    assert.equal(writes.length, 4);
    assert.equal(
      await page.getByRole("status", { name: "详情打开次数" }).innerText(),
      "0",
    );
    assert.equal(
      await page.getByText("周窗口重置", { exact: true }).count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("region", { name: "offline-slot 明细", exact: true })
        .count(),
      0,
    );
    assert.deepEqual(healthRequests, []);
    const scheduleSwitch = bar.locator("..").getByRole("switch");
    await scheduleSwitch.click();
    await page.waitForFunction(() =>
      document.querySelector('[aria-label="offline-slot 调度优先级"]')
        ?.parentElement.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true",
    );
    await scheduleSwitch.click();
    await page.waitForFunction(() =>
      document.querySelector('[aria-label="offline-slot 调度优先级"]')
        ?.parentElement.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false",
    );
    assert.deepEqual(switchWrites, [{ schedulable: true }, { schedulable: false }]);
    assert.equal(writes.length, 4);
    assert.equal(await block(8).getAttribute("aria-pressed"), "true");
    const row = bar.locator("xpath=ancestor::*[@data-vm-row]");
    const expand = row.getByRole("button", {
      name: "展开 offline-slot 明细",
      exact: true,
    });
    const detail = page.getByRole("region", {
      name: "offline-slot 明细",
      exact: true,
    });
    await row.focus();
    await page.keyboard.press("Enter");
    await detail.getByText("99.0%", { exact: true }).waitFor();
    const rangeTargets = await detail
      .getByRole("group", { name: "健康时间范围", exact: true })
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons.map((el) => {
          const box = el.getBoundingClientRect();
          return box.width >= 24 && box.height >= 24;
        }),
      );
    assert.deepEqual(rangeTargets, [true, true]);
    assert.equal(await detail.getByRole("region").count(), 3);
    await detail.getByLabel(/额度待刷新，最近测量/).waitFor();
    await detail.getByText("余额 12.5 点", { exact: true }).waitFor();
    assert.equal(
      await detail
        .getByRole("button", { name: "API配置", exact: true })
        .count(),
      1,
    );
    rejectHealth = true;
    await detail.getByRole("button", { name: "7D", exact: true }).click();
    await detail
      .getByText("加载失败：离线健康查询失败", { exact: true })
      .waitFor();
    await detail.getByRole("button", { name: "24h", exact: true }).click();
    await detail.getByText("99.0%", { exact: true }).waitFor();
    assert.deepEqual(
      healthRequests.map(({ range }) => range),
      ["24h", "7d"],
    );
    await row.focus();
    await page.keyboard.press("Space");
    assert.equal(await detail.count(), 0);
    await row
      .getByRole("button", { name: "打开 offline-slot 详情页", exact: true })
      .click();
    assert.equal(await detail.count(), 0);
    await row.focus();
    await page.keyboard.press("Shift+Enter");
    assert.equal(
      await page.getByRole("status", { name: "详情打开次数" }).innerText(),
      "2",
    );
    await row
      .getByText("offline@example.test", { exact: true })
      .evaluate((el) => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      });
    await row.dispatchEvent("click");
    assert.equal(await detail.count(), 0);
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await row.getByText("offline@example.test", { exact: true }).click();
    await detail.waitFor();
    await row.focus();
    await page.keyboard.press("Escape");
    assert.equal(await detail.count(), 0);
    await page
      .getByRole("button", { name: "展开 offline-manual6 明细", exact: true })
      .click();
    const emptyDetail = page.getByRole("region", {
      name: "offline-manual6 明细",
      exact: true,
    });
    await emptyDetail.getByText("该时段无请求", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "收起 offline-manual6 明细", exact: true })
      .click();
    const capture = async (name) => {
      await page.screenshot({
        path: path.join(screenshots, `${name}-rows.png`),
        fullPage: true,
      });
      await expand.click();
      await detail.getByText("99.0%", { exact: true }).waitFor();
      await page.locator("div.overflow-x-auto").evaluate((el) => {
        el.scrollLeft = 0;
      });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: path.join(screenshots, `${name}-expanded.png`),
        fullPage: true,
      });
      await row
        .getByRole("button", { name: "收起 offline-slot 明细", exact: true })
        .click();
      await visualBar.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollTo(0, 0));
      const cell = await visualBar.locator('xpath=ancestor::*[@data-slot="vm-usage-cell"]').boundingBox();
      const last = await page
        .locator("[data-vm-row]")
        .filter({
          has: page.getByRole("group", {
            name: "offline-manual10 调度优先级",
            exact: true,
          }),
        })
        .boundingBox();
      await page.screenshot({
        path: path.join(screenshots, `${name}-column.png`),
        clip: {
          x: Math.max(0, cell.x - 4),
          y: cell.y - 4,
          width: Math.min(cell.width + 8, page.viewportSize().width - Math.max(0, cell.x - 4)),
          height: last.y + last.height - cell.y + 8,
        },
      });
    };
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement?.blur());
    await capture("light-wide");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await capture("dark-wide");
    await page.evaluate(() => {
      document.documentElement.style.zoom = "1.5";
    });
    const zoomGeometry = await visualBar.evaluate((el) => ({
      layoutWidth: el.clientWidth,
      renderedWidth: el.getBoundingClientRect().width,
    }));
    assert.deepEqual(zoomGeometry, { layoutWidth: 268, renderedWidth: 402 });
    await capture("dark-150pct");
    await page.evaluate(() => {
      document.documentElement.style.zoom = "";
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await visualBar.scrollIntoViewIfNeeded();
    await capture("dark-narrow");
    await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(() =>
      document.documentElement.classList.remove("dark"),
    );
    await capture("light-narrow");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "1.5";
    });
    await capture("light-150pct");
    await page.evaluate(() => {
      document.documentElement.style.zoom = "";
    });
    const coarseContext = await browser.newContext({
      viewport: { width: 800, height: 600 },
      hasTouch: true,
    });
    await coarseContext.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === "/api/panel/me")
        return route.fulfill({
          json: { ok: true, data: { user: "offline", role: "admin" } },
        });
      if (url.pathname === "/api/panel/vms")
        return route.fulfill({
          json: { ok: true, data: { items: visualRows } },
        });
      return route.continue();
    });
    await coarseContext.addInitScript(() =>
      localStorage.setItem("kin_console_token", "offline-scheduling-token"),
    );
    const coarsePage = await coarseContext.newPage();
    await coarsePage.goto(`${origin}/offline-ui`);
    const coarseBlock = coarsePage.getByRole("button", {
      name: "offline-auto1 调度优先级 1",
      exact: true,
    });
    await coarseBlock.waitFor();
    const coarseGeometry = await coarseBlock.evaluate((el) => ({
      target: el.getBoundingClientRect().height,
      width: el.getBoundingClientRect().width,
      visible: el
        .querySelector('[data-slot="priority-segment"]')
        .getBoundingClientRect().height,
    }));
    assert.equal(coarseGeometry.target, 44);
    assert.equal(coarseGeometry.width, 44);
    assert.equal(coarseGeometry.visible, 6);
    await coarseContext.close();
    for (role of ["user", "super"]) {
      await page.reload();
      await bar.waitFor();
      const beforeHealth = healthRequests.length;
      assert.equal(await bar.getByRole("button").count(), 0);
      assert.equal(await auto.count(), 0);
      await expand.click();
      await detail
        .getByText("健康明细仅管理员可查看", { exact: true })
        .waitFor();
      assert.equal(healthRequests.length, beforeHealth);
    }
    assert.equal(writes.length, 4);
    assert.deepEqual(rejectedOrigins, []);
    assert.deepEqual(errors, []);
  },
);
