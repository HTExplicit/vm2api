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
  "list scheduling uses one column and saves exact independent changes",
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
      schedule_level: 6,
      schedule_level_mode: "auto",
      has_token: true,
      email: "offline@example.test",
      reset_7d: "2026-11-21T01:00:00Z",
    };
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
        return route.fulfill({ json: { ok: true, data: { items: [vm] } } });
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
    assert.equal(await bar.getByRole("button").count(), 10);
    for (let n = 1; n <= 10; n++) assert.equal(await block(n).innerText(), "");
    const boxes = await bar.getByRole("button").evaluateAll((buttons) =>
      buttons.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, width: r.width, height: r.height };
      }),
    );
    assert.ok(boxes.every((b) => b.width >= 24 && b.height >= 24));
    for (let n = 1; n < boxes.length; n++)
      assert.ok(Math.abs(boxes[n].x - boxes[n - 1].x - boxes[n - 1].width) < 1);
    await block(6).focus();
    await page
      .getByRole("tooltip", { name: "调度优先级 6", exact: true })
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
    const screenshots = path.join(root, ".tmp/113-scheduling");
    fs.mkdirSync(screenshots, { recursive: true });
    await page.screenshot({
      path: path.join(screenshots, "desktop.png"),
      fullPage: true,
    });
    await bar
      .locator("..")
      .screenshot({ path: path.join(screenshots, "column.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({
      path: path.join(screenshots, "dark.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(screenshots, "mobile.png"),
      fullPage: true,
    });
    role = "user";
    await page.reload();
    await bar.waitFor();
    assert.equal(await bar.getByRole("button").count(), 0);
    assert.equal(await auto.count(), 0);
    assert.equal(writes.length, 4);
    assert.deepEqual(rejectedOrigins, []);
    assert.deepEqual(errors, []);
  },
);
