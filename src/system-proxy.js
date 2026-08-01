import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function parseMacSystemProxy(output) {
  const text = String(output ?? "");
  const result = {};
  const httpProxy = enabledProxy(text, "HTTP");
  const httpsProxy = enabledProxy(text, "HTTPS");
  if (httpProxy) result.HTTP_PROXY = httpProxy;
  if (httpsProxy) result.HTTPS_PROXY = httpsProxy;

  const exceptions = parseExceptions(text);
  if (exceptions.length) result.NO_PROXY = exceptions.join(",");
  return result;
}

export async function inheritMacSystemProxy({
  environment = process.env,
  platform = process.platform,
  readProxySettings = readMacProxySettings
} = {}) {
  const applied = {};
  if (platform !== "darwin") return { applied };

  const needsHttp = !hasEnvironmentValue(environment, "HTTP_PROXY");
  const needsHttps = !hasEnvironmentValue(environment, "HTTPS_PROXY");
  if (!needsHttp && !needsHttps) return { applied };

  let discovered;
  try {
    discovered = parseMacSystemProxy(await readProxySettings());
  } catch (error) {
    return { applied, error };
  }

  if (needsHttp && discovered.HTTP_PROXY) {
    environment.HTTP_PROXY = discovered.HTTP_PROXY;
    applied.HTTP_PROXY = discovered.HTTP_PROXY;
  }
  if (needsHttps && discovered.HTTPS_PROXY) {
    environment.HTTPS_PROXY = discovered.HTTPS_PROXY;
    applied.HTTPS_PROXY = discovered.HTTPS_PROXY;
  }
  if (
    Object.keys(applied).length
    && discovered.NO_PROXY
    && !hasEnvironmentValue(environment, "NO_PROXY")
  ) {
    environment.NO_PROXY = discovered.NO_PROXY;
    applied.NO_PROXY = discovered.NO_PROXY;
  }
  return { applied };
}

async function readMacProxySettings() {
  const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--proxy"], {
    timeout: 2000,
    maxBuffer: 1024 * 1024
  });
  return stdout;
}

function enabledProxy(text, prefix) {
  if (scalar(text, `${prefix}Enable`) !== "1") return null;
  const host = scalar(text, `${prefix}Proxy`);
  const port = Number(scalar(text, `${prefix}Port`));
  if (!host || /[\s/?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  // macOS HTTP and HTTPS proxy entries both describe an HTTP CONNECT proxy.
  return `http://${formattedHost}:${port}`;
}

function scalar(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`^\\s*${escaped}\\s*:\\s*(.*?)\\s*$`, "m"))?.[1]?.trim() ?? "";
}

function parseExceptions(text) {
  const values = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (/^\s*ExceptionsList\s*:\s*<array>\s*{/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^\s*}/.test(line)) break;
    const value = line.match(/^\s*\d+\s*:\s*(.*?)\s*$/)?.[1]?.trim();
    if (!value || value === "<local>") continue;
    values.push(value.startsWith("*.") ? value.slice(1) : value);
  }
  return [...new Set(values)];
}

function hasEnvironmentValue(environment, name) {
  return Boolean(environment[name] || environment[name.toLowerCase()]);
}
