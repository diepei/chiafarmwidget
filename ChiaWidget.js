/* global Color, ListWidget, Font, Keychain, FileManager, Alert, SFSymbol, Size, LinearGradient, Point, config, args, Script */
// Chia Monitor for Scriptable — run once inside Scriptable to configure.

const SETTINGS_URL = "chia-monitor-agent-url";
const SETTINGS_TOKEN = "chia-monitor-api-token";
const ALERT_FINGERPRINT = "chia-monitor-alert-fingerprint";
const CACHE_FILE = "chia-monitor-widget-cache.json";
// The agent refreshes every 30 seconds. A response older than two minutes is
// not a live miner status, even if the HTTP request itself succeeded.
const STALE_AFTER_SECONDS = 120;

const palette = {
  background: "#07130C",
  panel: "#122219",
  panelSoft: "#182B20",
  text: "#F5FAF6",
  secondary: "#9AA99F",
  healthy: "#5ECE71",
  warning: "#F2BD5E",
  critical: "#F06D66",
  stale: "#8D9B94",
};

function saved(key) {
  return Keychain.contains(key) ? Keychain.get(key) : "";
}

async function configure() {
  const form = new Alert();
  form.title = "Connect Chia Monitor";
  form.message = "Enter the private Tailscale HTTPS address and API token printed by the miner installer.";
  form.addTextField("https://miner.tailnet.ts.net", saved(SETTINGS_URL));
  form.addSecureTextField("API token", saved(SETTINGS_TOKEN));
  form.addAction("Test and save");
  form.addCancelAction("Cancel");
  const choice = await form.presentAlert();
  if (choice === -1) return false;

  const url = form.textFieldValue(0).trim().replace(/\/$/, "");
  const token = form.textFieldValue(1).trim();
  if (!url.startsWith("https://") || token.length < 16) {
    await showMessage("Invalid configuration", "Use the HTTPS address shown by Tailscale and the complete API token.");
    return configure();
  }

  try {
    await requestData(url, token);
    Keychain.set(SETTINGS_URL, url);
    Keychain.set(SETTINGS_TOKEN, token);
    await showMessage("Connected", "Chia Monitor is ready. Add this script as a Scriptable widget.");
    return true;
  } catch (error) {
    await showMessage("Connection failed", `${error.message}\n\nCheck Tailscale, the agent service, URL and token.`);
    return configure();
  }
}

async function showMessage(title, message) {
  const alert = new Alert();
  alert.title = title;
  alert.message = message;
  alert.addAction("OK");
  await alert.presentAlert();
}

async function requestData(url, token) {
  // Scriptable may otherwise reuse a cached GET after the miner disappears.
  const request = new Request(`${url}/api/widget?_=${Date.now()}`);
  request.cachePolicy = "reloadIgnoringLocalCacheData";
  request.headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Cache-Control": "no-cache, no-store, max-age=0",
  };
  request.timeoutInterval = 10;
  const data = await request.loadJSON();
  if (request.response?.statusCode !== 200) {
    throw new Error(`Monitor returned HTTP ${request.response?.statusCode || "error"}`);
  }
  if (isOld(data?.updated_at)) {
    throw new Error("Monitor heartbeat is stale");
  }
  return data;
}

function cachePath() {
  const fm = FileManager.local();
  return fm.joinPath(fm.documentsDirectory(), CACHE_FILE);
}

function writeCache(data) {
  FileManager.local().writeString(cachePath(), JSON.stringify(data));
}

function readCache() {
  const fm = FileManager.local();
  const path = cachePath();
  if (!fm.fileExists(path)) return null;
  try { return JSON.parse(fm.readString(path)); } catch { return null; }
}

async function loadFarm() {
  const url = saved(SETTINGS_URL);
  const token = saved(SETTINGS_TOKEN);
  if (!url || !token) return { data: null, stale: true, needsSetup: true };
  try {
    const data = await requestData(url, token);
    writeCache(data);
    return { data, stale: isOld(data.updated_at), needsSetup: false, live: true };
  } catch (error) {
    const cached = readCache();
    return { data: cached, stale: true, needsSetup: false, live: false, error: error.message };
  }
}

function isOld(timestamp) {
  const time = timestamp ? new Date(timestamp).getTime() : 0;
  return !time || !Number.isFinite(time) || Date.now() - time > STALE_AFTER_SECONDS * 1000;
}

function duration(seconds) {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function dailyXch(value) {
  const amount = Number(value || 0);
  if (!amount) return "—";
  if (amount < 0.001) return amount.toFixed(5);
  if (amount < 0.1) return amount.toFixed(4);
  return amount.toFixed(3);
}

function relativeTime(timestamp) {
  if (!timestamp) return "Never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function statusInfo(data, stale) {
  const status = stale ? "stale" : (data?.status || "critical");
  const labels = { healthy: "FARMING", warning: "ATTENTION", critical: "NOT FARMING", stale: "STALE" };
  return { status, label: labels[status], color: new Color(palette[status]) };
}

function addSymbol(stack, name, color, size = 12) {
  const symbol = SFSymbol.named(name);
  symbol.applyFont(Font.systemFont(size));
  const image = stack.addImage(symbol.image);
  image.tintColor = color;
  image.imageSize = new Size(size, size);
  return image;
}

function addMetric(parent, label, value, good = true) {
  const stack = parent.addStack();
  stack.layoutVertically();
  const caption = stack.addText(label);
  caption.font = Font.semiboldMonospacedSystemFont(6.5);
  caption.textColor = new Color(palette.secondary);
  stack.addSpacer(2);
  const text = stack.addText(value);
  text.font = Font.semiboldSystemFont(10.5);
  text.textColor = good ? new Color(palette.text) : new Color(palette.critical);
  text.lineLimit = 1;
  text.minimumScaleFactor = 0.65;
  return stack;
}

function metricValue(data, keys, fallback = 0) {
  for (const key of keys) {
    const value = key.split(".").reduce((object, part) => object?.[part], data);
    if (value !== undefined && value !== null) return value;
  }
  return fallback;
}

function addHealthPill(parent, label, healthy) {
  const pill = parent.addStack();
  pill.centerAlignContent();
  pill.backgroundColor = new Color(healthy ? "#173D24" : "#3B241C");
  pill.cornerRadius = 7;
  pill.setPadding(4, 7, 4, 7);
  addSymbol(pill, healthy ? "checkmark.circle.fill" : "exclamationmark.circle.fill", new Color(healthy ? palette.healthy : palette.warning), 9);
  pill.addSpacer(4);
  const text = pill.addText(label);
  text.font = Font.semiboldSystemFont(8);
  text.textColor = new Color(palette.text);
  text.lineLimit = 1;
  return pill;
}

function addActivityCard(parent, symbol, label, value, healthy = true) {
  const card = parent.addStack();
  card.layoutVertically();
  card.backgroundColor = new Color(palette.panel);
  card.cornerRadius = 11;
  card.setPadding(8, 9, 7, 9);

  const top = card.addStack();
  top.centerAlignContent();
  addSymbol(top, symbol, new Color(healthy ? palette.healthy : palette.warning), 10);
  top.addSpacer();
  const number = top.addText(String(value));
  number.font = Font.boldRoundedSystemFont(17);
  number.textColor = new Color(healthy ? palette.text : palette.warning);
  number.minimumScaleFactor = 0.65;
  card.addSpacer(3);
  const caption = card.addText(label.toUpperCase());
  caption.font = Font.semiboldMonospacedSystemFont(5.8);
  caption.textColor = new Color(palette.secondary);
  caption.lineLimit = 1;
  caption.minimumScaleFactor = 0.55;
  return card;
}

function addPrimaryMetric(parent, label, value, accent = false) {
  const metric = parent.addStack();
  metric.layoutVertically();
  const caption = metric.addText(label.toUpperCase());
  caption.font = Font.semiboldMonospacedSystemFont(6);
  caption.textColor = new Color(palette.secondary);
  metric.addSpacer(2);
  const number = metric.addText(value);
  number.font = accent ? Font.boldRoundedSystemFont(19) : Font.semiboldRoundedSystemFont(14);
  number.textColor = new Color(accent ? palette.healthy : palette.text);
  number.lineLimit = 1;
  number.minimumScaleFactor = 0.6;
  return metric;
}

function addOperationalMetric(parent, label, value, healthy = true) {
  const metric = parent.addStack();
  metric.centerAlignContent();
  const dot = metric.addText(healthy ? "●" : "▲");
  dot.font = Font.systemFont(6);
  dot.textColor = new Color(healthy ? palette.healthy : palette.warning);
  metric.addSpacer(3);
  const caption = metric.addText(`${label.toUpperCase()}  ${value}`);
  caption.font = Font.semiboldMonospacedSystemFont(6);
  caption.textColor = new Color(palette.secondary);
  caption.lineLimit = 1;
  caption.minimumScaleFactor = 0.55;
  return metric;
}

function baseWidget(info) {
  const widget = new ListWidget();
  const gradient = new LinearGradient();
  gradient.colors = [new Color("#07130C"), new Color("#153320")];
  gradient.locations = [0, 1];
  gradient.startPoint = new Point(0, 0);
  gradient.endPoint = new Point(1, 1);
  widget.backgroundGradient = gradient;
  widget.setPadding(11, 12, 10, 12);
  widget.url = `scriptable:///run?scriptName=${encodeURIComponent(Script.name())}&action=refresh`;
  widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  const top = widget.addStack();
  top.centerAlignContent();
  const mark = top.addStack();
  mark.backgroundColor = new Color("#173D24");
  mark.cornerRadius = 7;
  mark.setPadding(3, 4, 3, 4);
  addSymbol(mark, "leaf.fill", new Color(palette.healthy), 10);
  top.addSpacer(5);
  const title = top.addText("Chia");
  title.font = Font.semiboldRoundedSystemFont(12);
  title.textColor = new Color(palette.text);
  top.addSpacer();
  const status = top.addText(info.label);
  status.font = Font.semiboldMonospacedSystemFont(7);
  status.textColor = info.color;
  return widget;
}

function buildHomeWidget(data, stale, family) {
  const info = statusInfo(data, stale);
  const widget = baseWidget(info);
  const missing = metricValue(data, ["missing_signage_points", "farming.missing_signage_points"]);
  const partials = metricValue(data, ["stale_partials", "pool.stale_partials", "farming.stale_partials"]);
  const farmerHealthy = !stale && Boolean(data?.farmer);
  const nodeHealthy = !stale && Boolean(data?.synced);
  const filterHealthy = farmerHealthy && nodeHealthy && Number(data?.failed_plots ?? 0) === 0;
  const harvestersHealthy = !stale && data?.harvesters?.total > 0 && data?.harvesters?.online === data?.harvesters?.total;
  const disksHealthy = !stale && data?.disks?.total > 0 && data?.disks?.online === data?.disks?.total;

  widget.addSpacer(family === "large" ? 11 : 7);
  const sync = widget.addStack();
  const compact = family === "small";
  addHealthPill(sync, stale ? "Node stale" : data?.synced ? (compact ? "Node" : "Node synced") : "Node syncing", nodeHealthy);
  sync.addSpacer(compact ? 4 : 6);
  addHealthPill(sync, stale ? "Farmer offline" : data?.farmer ? (compact ? "Farmer" : "Farmer online") : "Farmer offline", farmerHealthy);

  if (family === "small") {
    widget.addSpacer(8);
    const capacity = widget.addStack();
    addPrimaryMetric(capacity, "Plots", String(data?.plots ?? 0), true);
    capacity.addSpacer();
    addPrimaryMetric(capacity, "Space", `${data?.tib ?? 0} TiB`);
    widget.addSpacer(8);
    const estimates = widget.addStack();
    addMetric(estimates, "XCH / DAY", dailyXch(data?.estimated_daily_xch));
    estimates.addSpacer();
    addMetric(estimates, "WIN IN", `~${duration(data?.etw_seconds)}`);
  } else if (family === "medium") {
    widget.addSpacer(7);
    const overview = widget.addStack();
    const capacity = overview.addStack();
    capacity.layoutVertically();
    const farm = capacity.addStack();
    addPrimaryMetric(farm, "Plots", String(data?.plots ?? 0), true);
    farm.addSpacer(18);
    addPrimaryMetric(farm, "Farm space", `${data?.tib ?? 0} TiB`);
    overview.addSpacer();
    const estimates = overview.addStack();
    estimates.layoutVertically();
    const xch = estimates.addText(`${dailyXch(data?.estimated_daily_xch)} XCH/day`);
    xch.font = Font.semiboldRoundedSystemFont(11);
    xch.textColor = new Color(palette.text);
    xch.rightAlignText();
    estimates.addSpacer(3);
    const etw = estimates.addText(`Win in ~${duration(data?.etw_seconds)}`);
    etw.font = Font.mediumSystemFont(9);
    etw.textColor = new Color(palette.secondary);
    etw.rightAlignText();

    widget.addSpacer(7);
    const activity = widget.addStack();
    addOperationalMetric(activity, "Plot filter", filterHealthy ? "OK" : "CHECK", filterHealthy);
    activity.addSpacer();
    addOperationalMetric(activity, "Missing SP", missing, Number(missing) === 0);
    activity.addSpacer();
    addOperationalMetric(activity, "Stale", partials, Number(partials) === 0);
  } else {
    widget.addSpacer(10);
    const alertPanel = widget.addStack();
    alertPanel.centerAlignContent();
    alertPanel.backgroundColor = new Color(info.status === "healthy" ? "#122B1B" : "#34251B");
    alertPanel.cornerRadius = 10;
    alertPanel.setPadding(8, 10, 8, 10);
    addSymbol(alertPanel, info.status === "healthy" ? "checkmark.seal.fill" : "exclamationmark.triangle.fill", info.color, 12);
    alertPanel.addSpacer(7);
    const alertText = alertPanel.addText(data?.alerts?.[0]?.message || (stale ? "Showing the last saved farm reading" : "All farming systems are operating normally"));
    alertText.font = Font.semiboldSystemFont(10);
    alertText.textColor = new Color(palette.text);
    alertText.lineLimit = 1;

    widget.addSpacer(12);
    const overview = widget.addStack();
    addPrimaryMetric(overview, "Plots", String(data?.plots ?? 0), true);
    overview.addSpacer();
    addPrimaryMetric(overview, "Farm space", `${data?.tib ?? 0} TiB`);
    overview.addSpacer();
    addPrimaryMetric(overview, "XCH / day", dailyXch(data?.estimated_daily_xch));
    overview.addSpacer();
    addPrimaryMetric(overview, "Estimated win", `~${duration(data?.etw_seconds)}`);

    widget.addSpacer(13);
    const activity = widget.addStack();
    addActivityCard(activity, "line.3.horizontal.decrease.circle.fill", "Plot filter", filterHealthy ? "OK" : "CHECK", filterHealthy);
    activity.addSpacer(9);
    addActivityCard(activity, "clock.badge.exclamationmark", "Missing signage", missing, Number(missing) === 0);
    activity.addSpacer(9);
    addActivityCard(activity, "arrow.triangle.2.circlepath", "Stale partials", partials, Number(partials) === 0);

    widget.addSpacer(12);
    const infrastructure = widget.addStack();
    addOperationalMetric(infrastructure, "Harvesters", `${data?.harvesters?.online ?? 0}/${data?.harvesters?.total ?? 0}`, harvestersHealthy);
    infrastructure.addSpacer();
    addOperationalMetric(infrastructure, "Disks", `${data?.disks?.online ?? 0}/${data?.disks?.total ?? 0}`, disksHealthy);
    infrastructure.addSpacer();
    addOperationalMetric(infrastructure, "Updated", relativeTime(data?.updated_at), !stale);
  }

  widget.addSpacer();
  const footer = widget.addStack();
  footer.centerAlignContent();
  const summary = footer.addText(`LAST BLOCK  ${relativeTime(data?.last_block_at)}${data?.last_block_height ? ` · #${Number(data.last_block_height).toLocaleString()}` : ""}`);
  summary.font = Font.semiboldMonospacedSystemFont(6.2);
  summary.textColor = new Color(data?.last_block_at ? palette.secondary : palette.stale);
  summary.lineLimit = 1;
  summary.minimumScaleFactor = 0.55;
  footer.addSpacer();
  const updated = footer.addText(stale ? "CACHED" : `${data?.blocks_won ?? 0} WON`);
  updated.font = Font.semiboldMonospacedSystemFont(6.5);
  updated.textColor = stale ? new Color(palette.warning) : new Color(palette.secondary);
  return widget;
}

function buildAccessory(data, stale, family) {
  const widget = new ListWidget();
  const info = statusInfo(data, stale);
  if (family === "accessoryInline") {
    const text = widget.addText(`Chia ${info.label} · ${dailyXch(data?.estimated_daily_xch)} XCH/day`);
    text.font = Font.mediumSystemFont(12);
  } else if (family === "accessoryCircular") {
    const text = widget.addText(!stale && data?.farmer && data?.synced ? "✓" : "!");
    text.font = Font.boldRoundedSystemFont(24);
    text.centerAlignText();
  } else {
    const title = widget.addText(`Chia · ${info.label}`);
    title.font = Font.semiboldSystemFont(12);
    const detail = widget.addText(`${dailyXch(data?.estimated_daily_xch)} XCH/day · last ${relativeTime(data?.last_block_at)}`);
    detail.font = Font.systemFont(11);
  }
  widget.url = `scriptable:///run?scriptName=${encodeURIComponent(Script.name())}&action=refresh`;
  return widget;
}

function buildSetupWidget() {
  const widget = new ListWidget();
  widget.backgroundColor = new Color(palette.background);
  widget.setPadding(14, 14, 14, 14);
  const title = widget.addText("CHIA MONITOR");
  title.font = Font.semiboldMonospacedSystemFont(9);
  title.textColor = new Color(palette.healthy);
  widget.addSpacer();
  const text = widget.addText("Run this script once in Scriptable to connect your miner.");
  text.font = Font.semiboldSystemFont(13);
  text.textColor = new Color(palette.text);
  text.minimumScaleFactor = 0.7;
  widget.url = `scriptable:///run?scriptName=${encodeURIComponent(Script.name())}`;
  return widget;
}

function formatTime(timestamp) {
  if (!timestamp) return "—";
  try { return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return "—"; }
}

async function notifyForAlerts(data, live) {
  if (!live) return;
  const alerts = data?.alerts || [];
  if (!alerts.length) {
    if (Keychain.contains(ALERT_FINGERPRINT)) Keychain.remove(ALERT_FINGERPRINT);
    return;
  }
  const fingerprint = alerts.map(item => item.message).join("|");
  if (saved(ALERT_FINGERPRINT) === fingerprint) return;
  const notification = new Notification();
  notification.identifier = "chia-monitor-farm-alert";
  notification.threadIdentifier = "chia-monitor";
  notification.title = "Chia farm needs attention";
  notification.body = alerts[0].message;
  notification.sound = "alert";
  notification.openURL = `scriptable:///run?scriptName=${encodeURIComponent(Script.name())}&action=refresh`;
  await notification.schedule();
  Keychain.set(ALERT_FINGERPRINT, fingerprint);
}

if (config.runsInApp && args.queryParameters?.action !== "refresh") {
  const menu = new Alert();
  menu.title = "Chia Monitor";
  menu.message = saved(SETTINGS_URL) ? "Preview the widget or change the miner connection." : "Connect the widget to your miner.";
  menu.addAction(saved(SETTINGS_URL) ? "Preview" : "Configure");
  if (saved(SETTINGS_URL)) menu.addAction("Change connection");
  menu.addCancelAction("Cancel");
  const choice = await menu.presentSheet();
  if (choice === -1) Script.complete();
  if (!saved(SETTINGS_URL) || choice === 1) await configure();
}

const result = await loadFarm();
const family = config.widgetFamily || "medium";
const widget = result.needsSetup
  ? buildSetupWidget()
  : family.startsWith("accessory")
    ? buildAccessory(result.data, result.stale, family)
    : buildHomeWidget(result.data, result.stale, family);

await notifyForAlerts(result.data, result.live);
if (config.runsInWidget) Script.setWidget(widget);
else if (family === "small") await widget.presentSmall();
else if (family === "large") await widget.presentLarge();
else await widget.presentMedium();
Script.complete();
