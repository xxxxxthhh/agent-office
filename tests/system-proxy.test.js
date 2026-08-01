import "./_hang-watchdog.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  inheritMacSystemProxy,
  parseMacSystemProxy
} from "../src/system-proxy.js";

const CLASH_SETTINGS = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
    2 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
}`;

test("parses the enabled macOS HTTP proxies used by Clash", () => {
  assert.deepEqual(parseMacSystemProxy(CLASH_SETTINGS), {
    HTTP_PROXY: "http://127.0.0.1:7897",
    HTTPS_PROXY: "http://127.0.0.1:7897",
    NO_PROXY: "127.0.0.1,localhost,.local"
  });
});

test("inherits missing system proxy variables without overriding explicit agent environment", async () => {
  const environment = {
    HTTPS_PROXY: "http://explicit-proxy.example:8443",
    NO_PROXY: "internal.example"
  };
  let reads = 0;

  const result = await inheritMacSystemProxy({
    environment,
    platform: "darwin",
    readProxySettings: async () => {
      reads += 1;
      return CLASH_SETTINGS;
    }
  });

  assert.equal(reads, 1);
  assert.deepEqual(result.applied, {
    HTTP_PROXY: "http://127.0.0.1:7897"
  });
  assert.equal(environment.HTTP_PROXY, "http://127.0.0.1:7897");
  assert.equal(environment.HTTPS_PROXY, "http://explicit-proxy.example:8443");
  assert.equal(environment.NO_PROXY, "internal.example");
});

test("skips system inspection when both proxy protocols are already explicit", async () => {
  const environment = {
    http_proxy: "http://explicit-http.example:8080",
    https_proxy: "http://explicit-https.example:8443"
  };

  const result = await inheritMacSystemProxy({
    environment,
    platform: "darwin",
    readProxySettings: async () => {
      throw new Error("system proxy should not be read");
    }
  });

  assert.deepEqual(result.applied, {});
});
