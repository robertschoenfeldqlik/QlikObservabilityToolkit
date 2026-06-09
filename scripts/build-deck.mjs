// Build the Qlik Observability Toolkit architecture deck.
// Output: Qlik-Observability-Toolkit-Architecture.pptx (at the project root).
//
// Styled with the Qlik dev-portal palette extracted from the .potx template:
//   Qlik green   #009845 (primary accent)
//   Deep teal    #006580 (headers)
//   Bright cyan  #10CFC9 (callouts)
//   Deep blue    #19416C (data flow lines)
//   Purple       #93579C (Talend Cloud)
//   Slate        #2D3543 (text)
//   Light grey   #A9B3B6 (muted)
//   Off-white    #F6F7F8 (slide backgrounds)
// Font: Inter (the template's defined major/minor).
//
// This stands alone — to lock to the corporate template, run the
// template-merge skill afterwards with the .potx file.

import pptxgenjs from "pptxgenjs";

const QLIK_GREEN = "009845";
const TEAL_DEEP = "006580";
const TEAL_BRIGHT = "10CFC9";
const BLUE_DEEP = "19416C";
const PURPLE = "93579C";
const SLATE = "2D3543";
const MUTED = "A9B3B6";
const BG_LIGHT = "F6F7F8";
const WHITE = "FFFFFF";

const FONT = "Inter";

const pres = new pptxgenjs();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5
pres.title = "Qlik Observability Toolkit Architecture";
pres.author = "Qlik Observability Toolkit Server";
pres.company = "Built on the Qlik stack";

// ============================================================================
// Slide 1 — Cover
// ============================================================================
{
  const s = pres.addSlide();
  s.background = { color: BG_LIGHT };

  // Brand strip on the left
  s.addShape("rect", { x: 0, y: 0, w: 0.5, h: 7.5, fill: { color: QLIK_GREEN } });

  // Title block
  s.addText("Talend Cloud × Qlik Cloud", {
    x: 1.0,
    y: 1.4,
    w: 11.5,
    h: 0.6,
    fontFace: FONT,
    fontSize: 22,
    color: TEAL_DEEP,
    bold: false,
  });
  s.addText("Unified Observability Stack", {
    x: 1.0,
    y: 2.0,
    w: 11.5,
    h: 1.2,
    fontFace: FONT,
    fontSize: 44,
    color: SLATE,
    bold: true,
  });
  s.addText("MCP server · Prometheus · Loki · Grafana · Python exporters · Qlik Sense apps", {
    x: 1.0,
    y: 3.5,
    w: 11.5,
    h: 0.6,
    fontFace: FONT,
    fontSize: 16,
    color: MUTED,
  });

  // GitHub callout — pinned high so it's the first non-title thing the
  // viewer reads. Hyperlinked.
  s.addText("github.com/robertschoenfeldqlik/QlikObservabilityToolkit", {
    x: 1.0,
    y: 4.05,
    w: 11.5,
    h: 0.4,
    fontFace: FONT,
    fontSize: 14,
    color: QLIK_GREEN,
    bold: true,
    hyperlink: {
      url: "https://github.com/robertschoenfeldqlik/QlikObservabilityToolkit",
      tooltip: "Open repo",
    },
  });

  // Three callouts
  const card = (x, n, line1, line2) => {
    s.addShape("roundRect", {
      x,
      y: 4.7,
      w: 3.4,
      h: 1.6,
      fill: { color: WHITE },
      line: { color: MUTED, width: 0.5 },
      rectRadius: 0.08,
    });
    s.addText(n, {
      x: x + 0.2,
      y: 4.85,
      w: 3.0,
      h: 0.5,
      fontFace: FONT,
      fontSize: 30,
      color: QLIK_GREEN,
      bold: true,
    });
    s.addText(line1, {
      x: x + 0.2,
      y: 5.35,
      w: 3.0,
      h: 0.35,
      fontFace: FONT,
      fontSize: 13,
      color: SLATE,
      bold: true,
    });
    s.addText(line2, {
      x: x + 0.2,
      y: 5.65,
      w: 3.0,
      h: 0.55,
      fontFace: FONT,
      fontSize: 11,
      color: MUTED,
    });
  };
  card(1.0, "9", "observability tools", "Read-only Talend observability surface (+ tenant-discovery meta-tool), auto-generated from OpenAPI specs.");
  card(4.7, "N+N", "tenants", "Multiple Talend + multiple Qlik tenants in one config.");
  card(8.4, "4", "Python exporters", "Business · Engine logs · QVD upload · Qlik observability.");
}

// ============================================================================
// Slide 2 — Architecture diagram (Qlik-styled, real Qlik icons)
// ============================================================================
{
  const s = pres.addSlide();
  s.background = { color: "FFFFFF" };
  const ICON = "deploy/assets/icons";

  // Qlik logo, top-right (from the corporate template's media).
  try {
    s.addImage({ path: "deploy/assets/qlik-logo.svg", x: 11.5, y: 0.32, w: 1.35, h: 0.75 });
  } catch {
    /* logo optional */
  }

  s.addText("Qlik Observability Toolkit — architecture", {
    x: 0.5, y: 0.3, w: 10.6, h: 0.55, fontFace: FONT, fontSize: 25, color: TEAL_DEEP, bold: true,
  });
  s.addText("Three planes: data sources → collection & control → storage, visualization & analytics.", {
    x: 0.5, y: 0.85, w: 10.6, h: 0.35, fontFace: FONT, fontSize: 12.5, color: MUTED,
  });

  // ---- Plane backdrop panels ----
  const planeY = 1.45;
  const planeH = 5.0;
  const plane = (x, w, label, tint) => {
    s.addShape("roundRect", {
      x, y: planeY, w, h: planeH,
      fill: { color: tint }, line: { color: "E1E4E8", width: 1 }, rectRadius: 0.08,
    });
    s.addText(label, {
      x: x + 0.15, y: planeY + 0.12, w: w - 0.3, h: 0.3,
      fontFace: FONT, fontSize: 11, color: TEAL_DEEP, bold: true, charSpacing: 1,
    });
  };
  plane(0.5, 3.7, "DATA SOURCES", "F2F8F4");
  plane(4.5, 4.55, "COLLECTION + CONTROL PLANE", "F1F6F8");
  plane(9.35, 3.45, "STORE · VISUALIZE · ANALYZE", "F4F1F8");

  // ---- Card with a real Qlik icon PNG ----
  const card = (x, y, w, h, icon, title, sub, accent) => {
    s.addShape("roundRect", {
      x, y, w, h,
      fill: { color: "FFFFFF" }, line: { color: accent, width: 1.25 }, rectRadius: 0.07,
    });
    s.addShape("roundRect", { x, y, w: 0.1, h, fill: { color: accent }, line: { type: "none" }, rectRadius: 0.07 });
    // Real Qlik icon in a soft tinted square.
    s.addImage({ path: `${ICON}/${icon}`, x: x + 0.24, y: y + (h - 0.62) / 2, w: 0.62, h: 0.62 });
    s.addText(title, {
      x: x + 1.0, y: y + 0.12, w: w - 1.1, h: 0.34,
      fontFace: FONT, fontSize: 12, color: SLATE, bold: true,
    });
    if (sub) {
      s.addText(sub, {
        x: x + 1.0, y: y + 0.44, w: w - 1.1, h: h - 0.52,
        fontFace: FONT, fontSize: 9, color: MUTED, valign: "top",
      });
    }
  };

  const cardH = 0.95;
  const gap = 0.3;
  const rowY = (i) => planeY + 0.5 + i * (cardH + gap);

  // Sources plane
  card(0.65, rowY(0), 3.4, cardH, "talend-cloud.png", "Talend Cloud — N tenants", "Orchestration · Observability · Exec-history · Audit", PURPLE);
  card(0.65, rowY(1), 3.4, cardH, "qlik-cloud.png", "Qlik Cloud — N tenants", "Apps · Reloads · Audit · Quotas", QLIK_GREEN);
  card(0.65, rowY(2), 3.4, cardH, "remote-engine.png", "Remote Engine hosts", "JSON job-management logs on Linux", TEAL_DEEP);

  // Collection plane
  card(4.65, rowY(0), 4.25, cardH, "mcp.png", "MCP server (TS)", "stdio · per-tenant routing · observability preset", BLUE_DEEP);
  card(4.65, rowY(1), 4.25, cardH, "exporters.png", "Python exporters ×4", "business · engine-logs · qlik-obs · qvd", BLUE_DEEP);
  card(4.65, rowY(2), 4.25, cardH, "extractor.png", "qlik-engine-extractor", "headless agent · self-diagnosing · heartbeats", QLIK_GREEN);

  // Sink plane
  card(9.5, rowY(0), 3.15, cardH, "prometheus.png", "Prometheus", "scrape all /metrics · 14d", SLATE);
  card(9.5, rowY(1), 3.15, cardH, "grafana.png", "Loki + Grafana", "logs + 2 dashboards", TEAL_BRIGHT);
  card(9.5, rowY(2), 3.15, cardH, "qlik-app.png", "Qlik Sense Cloud app", "QVD-driven trend / BI", QLIK_GREEN);

  // ---- Connector arrows between planes ----
  const arrow = (x1, y1, x2, y2, color) => {
    s.addShape("line", {
      x: x1, y: y1, w: x2 - x1, h: y2 - y1,
      line: { color, width: 1.75, endArrowType: "triangle" },
    });
  };
  const midL = 4.05, midR = 4.65, sinkL = 8.9, sinkR = 9.5;
  const cy = (i) => rowY(i) + cardH / 2;
  arrow(midL, cy(0), midR, cy(0), PURPLE);
  arrow(midL, cy(1), midR, cy(2), QLIK_GREEN);
  arrow(midL, cy(2), midR, cy(2), TEAL_DEEP);
  arrow(sinkL, cy(0), sinkR, cy(0), BLUE_DEEP);
  arrow(sinkL, cy(1), sinkR, cy(0), BLUE_DEEP);
  arrow(sinkL, cy(2), sinkR, cy(0), BLUE_DEEP);
  arrow(11.07, cy(0) + 0.45, 11.07, cy(1), BLUE_DEEP);
  arrow(11.07, cy(1) + 0.45, 11.07, cy(2), QLIK_GREEN);

  // QVD bridge caption with a small data-transfer icon.
  s.addImage({ path: `${ICON}/qvd.png`, x: 0.5, y: 6.58, w: 0.42, h: 0.42 });
  s.addText(
    "QVD bridge: Prometheus PromQL → long-form (timestamp, metric, labels, value) rows → QVD via pyqvd → Qlik Cloud Data Files API → analyst sheets.",
    { x: 1.0, y: 6.6, w: 11.8, h: 0.45, fontFace: FONT, fontSize: 10, color: SLATE, italic: true, valign: "middle" },
  );
  s.addShape("rect", { x: 0, y: 7.2, w: 13.333, h: 0.3, fill: { color: QLIK_GREEN } });
}

// ============================================================================
// Slide 3 — Multi-tenant model
// ============================================================================
{
  const s = pres.addSlide();
  s.background = { color: BG_LIGHT };

  s.addText("Multi-tenant by design", {
    x: 0.5,
    y: 0.25,
    w: 12.3,
    h: 0.6,
    fontFace: FONT,
    fontSize: 26,
    color: TEAL_DEEP,
    bold: true,
  });
  s.addText(
    "One config.json (v2 schema) lists every Talend tenant and every Qlik tenant. The UI manages them; exporters fan out by reading the same file.",
    {
      x: 0.5,
      y: 0.85,
      w: 12.3,
      h: 0.5,
      fontFace: FONT,
      fontSize: 13,
      color: MUTED,
    },
  );

  // Two side-by-side panes
  const pane = (x, title, color, rows) => {
    s.addShape("roundRect", {
      x,
      y: 1.6,
      w: 6.0,
      h: 5.3,
      fill: { color: WHITE },
      line: { color: MUTED, width: 0.5 },
      rectRadius: 0.08,
    });
    s.addShape("rect", { x, y: 1.6, w: 6.0, h: 0.5, fill: { color } });
    s.addText(title, {
      x: x + 0.2,
      y: 1.65,
      w: 5.6,
      h: 0.4,
      fontFace: FONT,
      fontSize: 14,
      color: WHITE,
      bold: true,
    });
    rows.forEach((r, i) => {
      const y = 2.2 + i * 0.7;
      s.addText(r.id, {
        x: x + 0.2,
        y,
        w: 1.4,
        h: 0.3,
        fontFace: FONT,
        fontSize: 11,
        color: SLATE,
        bold: true,
        fontFace_: "monospace",
      });
      s.addText(r.label, {
        x: x + 0.2,
        y: y + 0.28,
        w: 1.4,
        h: 0.3,
        fontFace: FONT,
        fontSize: 10,
        color: MUTED,
      });
      s.addText(r.url, {
        x: x + 1.7,
        y,
        w: 4.1,
        h: 0.3,
        fontFace: FONT,
        fontSize: 10.5,
        color: SLATE,
      });
      s.addText(r.creds, {
        x: x + 1.7,
        y: y + 0.3,
        w: 4.1,
        h: 0.3,
        fontFace: FONT,
        fontSize: 10,
        color: MUTED,
      });
      if (r.def) {
        s.addShape("roundRect", {
          x: x + 5.05,
          y: y + 0.02,
          w: 0.85,
          h: 0.28,
          fill: { color: QLIK_GREEN },
          line: { type: "none" },
          rectRadius: 0.04,
        });
        s.addText("default", {
          x: x + 5.05,
          y: y + 0.04,
          w: 0.85,
          h: 0.24,
          fontFace: FONT,
          fontSize: 9,
          color: WHITE,
          bold: true,
          align: "center",
        });
      }
    });
  };

  pane(0.5, "Talend Cloud tenants", PURPLE, [
    {
      id: "prod-us",
      label: "Production (US)",
      url: "https://api.us.cloud.talend.com",
      creds: "PAT · keychain",
      def: true,
    },
    { id: "dev-eu", label: "Dev (EU)", url: "https://api.eu.cloud.talend.com", creds: "PAT · file" },
    {
      id: "private",
      label: "Private cloud",
      url: "https://api.internal.example.com",
      creds: "PAT · keychain  (URL override)",
    },
    { id: "ap-test", label: "AP testing", url: "https://api.ap.cloud.talend.com", creds: "PAT · file" },
    {
      id: "azure-w",
      label: "Azure US-West",
      url: "https://api.us-west.cloud.talend.com",
      creds: "PAT · file",
    },
  ]);

  pane(6.8, "Qlik Cloud tenants", QLIK_GREEN, [
    {
      id: "qlik-prod",
      label: "Prod tenant",
      url: "https://prod.us.qlikcloud.com",
      creds: "API key · keychain · DataFiles connection",
      def: true,
    },
    { id: "qlik-eu", label: "EU tenant", url: "https://eu.eu.qlikcloud.com", creds: "API key · file" },
    { id: "qlik-dev", label: "Dev sandbox", url: "https://dev.us.qlikcloud.com", creds: "API key · file" },
  ]);
}

// ============================================================================
// Slide 4 — Tool surface & UI
// ============================================================================
{
  const s = pres.addSlide();
  s.background = { color: BG_LIGHT };

  s.addText("MCP tool surface · configuration UI · Python control", {
    x: 0.5,
    y: 0.25,
    w: 12.3,
    h: 0.6,
    fontFace: FONT,
    fontSize: 24,
    color: TEAL_DEEP,
    bold: true,
  });

  // Two-row layout: top = MCP presets, bottom = UI tabs
  // MCP preset row
  s.addText("MCP TOOL PRESETS", {
    x: 0.5,
    y: 1.1,
    w: 6.0,
    h: 0.3,
    fontFace: FONT,
    fontSize: 11,
    color: MUTED,
    bold: true,
  });
  const presetCard = (x, y, name, count, desc, recommended = false) => {
    s.addShape("roundRect", {
      x,
      y,
      w: 2.95,
      h: 2.3,
      fill: { color: WHITE },
      line: { color: recommended ? QLIK_GREEN : MUTED, width: recommended ? 1.5 : 0.5 },
      rectRadius: 0.06,
    });
    s.addText(name, {
      x: x + 0.15,
      y: y + 0.15,
      w: 2.6,
      h: 0.35,
      fontFace: FONT,
      fontSize: 14,
      color: SLATE,
      bold: true,
    });
    s.addText(`${count} tools`, {
      x: x + 0.15,
      y: y + 0.55,
      w: 2.6,
      h: 0.3,
      fontFace: FONT,
      fontSize: 11,
      color: QLIK_GREEN,
      bold: true,
    });
    s.addText(desc, {
      x: x + 0.15,
      y: y + 0.85,
      w: 2.65,
      h: 1.35,
      fontFace: FONT,
      fontSize: 10,
      color: MUTED,
    });
    if (recommended) {
      s.addText("DEFAULT — LOADED OUT OF THE BOX", {
        x: x + 0.15,
        y: y + 1.95,
        w: 2.65,
        h: 0.3,
        fontFace: FONT,
        fontSize: 8,
        color: QLIK_GREEN,
        bold: true,
      });
    }
  };
  presetCard(
    0.5,
    1.5,
    "observability",
    "9",
    "Default. Pure read-only: observability-metrics, execution-logs, execution-history-search, plus the tenant-discovery meta-tool. Drops audit.",
    true,
  );
  presetCard(3.6, 1.5, "logging", "10", "Same as observability + audit-logs (identity events).");
  // Observability-only by design — the legacy orchestrate / all bundles were removed.
  s.addShape("roundRect", {
    x: 6.7, y: 1.5, w: 6.13, h: 2.3,
    fill: { color: WHITE }, line: { color: MUTED, width: 0.5 }, rectRadius: 0.06,
  });
  s.addText("Observability-only by design", {
    x: 6.85, y: 1.65, w: 5.8, h: 0.35, fontFace: FONT, fontSize: 14, color: SLATE, bold: true,
  });
  s.addText(
    "No orchestration or admin endpoints are exposed. The MCP server defaults to the observability preset; only the observability and logging presets ship. Need a wider surface? Pass an explicit TMC_APIS=<comma,list> — but the product is scoped to read-only observability.",
    { x: 6.85, y: 2.05, w: 5.8, h: 1.6, fontFace: FONT, fontSize: 10, color: MUTED },
  );

  // UI tab row
  s.addText("CONFIGURATION UI (npm run config-ui)", {
    x: 0.5,
    y: 4.1,
    w: 8.0,
    h: 0.3,
    fontFace: FONT,
    fontSize: 11,
    color: MUTED,
    bold: true,
  });
  const tab = (x, y, name, desc, accent) => {
    s.addShape("roundRect", {
      x,
      y,
      w: 2.95,
      h: 2.6,
      fill: { color: WHITE },
      line: { color: MUTED, width: 0.5 },
      rectRadius: 0.06,
    });
    s.addShape("rect", { x, y, w: 2.95, h: 0.4, fill: { color: accent } });
    s.addText(name, {
      x: x + 0.15,
      y: y + 0.06,
      w: 2.6,
      h: 0.3,
      fontFace: FONT,
      fontSize: 12,
      color: WHITE,
      bold: true,
    });
    s.addText(desc, {
      x: x + 0.15,
      y: y + 0.55,
      w: 2.65,
      h: 2.0,
      fontFace: FONT,
      fontSize: 10,
      color: SLATE,
    });
  };
  tab(
    0.5,
    4.5,
    "Talend Cloud",
    "Add / edit / delete tenants. Per-tenant region + URL override. Test connection. File or OS-keyring storage.",
    PURPLE,
  );
  tab(
    3.6,
    4.5,
    "Qlik Cloud",
    "Add / edit / delete tenants. Tenant URL + API key + Data Files connection ID. Test against /api/v1/users/me.",
    QLIK_GREEN,
  );
  tab(
    6.7,
    4.5,
    "Exporters",
    "Live status of every Python exporter (Docker-aware). Start / Stop with one click. Shows active series count.",
    BLUE_DEEP,
  );
  tab(
    9.8,
    4.5,
    "About",
    "Config file location, keyring backend status, nuke-all button, shutdown button.",
    TEAL_DEEP,
  );
}

// ============================================================================
// Slide 5 — Closing references
// ============================================================================
{
  const s = pres.addSlide();
  s.background = { color: TEAL_DEEP };

  s.addText("References", {
    x: 0.5,
    y: 0.4,
    w: 12.3,
    h: 0.7,
    fontFace: FONT,
    fontSize: 30,
    color: WHITE,
    bold: true,
  });
  s.addText("Single index in HELP.md. Every external doc this project relies on, sorted by topic.", {
    x: 0.5,
    y: 1.15,
    w: 12.3,
    h: 0.4,
    fontFace: FONT,
    fontSize: 13,
    color: TEAL_BRIGHT,
  });

  // Pinned repo URL — first reference, hyperlinked.
  s.addShape("roundRect", {
    x: 0.5,
    y: 1.65,
    w: 12.3,
    h: 0.6,
    fill: { color: QLIK_GREEN },
    line: { type: "none" },
    rectRadius: 0.08,
  });
  s.addText("▸  github.com/robertschoenfeldqlik/QlikObservabilityToolkit", {
    x: 0.7,
    y: 1.72,
    w: 11.9,
    h: 0.45,
    fontFace: FONT,
    fontSize: 16,
    color: WHITE,
    bold: true,
    hyperlink: {
      url: "https://github.com/robertschoenfeldqlik/QlikObservabilityToolkit",
      tooltip: "Open repo",
    },
  });

  const refs = [
    ["Talend Cloud APIs", "https://talend.qlik.dev/apis/"],
    [
      "Talend Remote Engine job logs",
      "https://help.qlik.com/talend/en-US/remote-engine-user-guide-linux/Cloud/job-management-logs",
    ],
    ["Qlik Cloud APIs (qlik.dev)", "https://qlik.dev/apis/"],
    ["Qlik Cloud Data Files API", "https://qlik.dev/apis/rest/data-files/"],
    ["Qlik Cloud API key management", "https://qlik.dev/authenticate/api-key/manage-api-keys/"],
    ["Qlik UI palette source", "https://qlik.dev/manage/data-connections/create-data-connections/"],
    ["Model Context Protocol", "https://modelcontextprotocol.io/specification"],
    ["Prometheus metric naming", "https://prometheus.io/docs/practices/naming/"],
    [
      "Grafana dashboard provisioning",
      "https://grafana.com/docs/grafana/latest/administration/provisioning/",
    ],
    ["Loki / Promtail", "https://grafana.com/docs/loki/latest/"],
    ["pyqvd (Python QVD I/O)", "https://pypi.org/project/pyqvd/"],
    ["@napi-rs/keyring (OS keyring binding)", "https://github.com/Brooooooklyn/keyring-node"],
  ];

  refs.forEach((r, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.5 + col * 6.3;
    const y = 2.55 + row * 0.55;
    s.addText(r[0], { x, y, w: 2.6, h: 0.3, fontFace: FONT, fontSize: 11, color: TEAL_BRIGHT, bold: true });
    s.addText(r[1], { x: x + 2.6, y, w: 3.7, h: 0.3, fontFace: FONT, fontSize: 10, color: WHITE });
  });

  // Footer
  s.addShape("rect", { x: 0, y: 7.1, w: 13.333, h: 0.4, fill: { color: QLIK_GREEN } });
  s.addText("Qlik Observability Toolkit · built on the Qlik stack · Inter typeface · #009845 / #006580 / #19416C", {
    x: 0.5,
    y: 7.16,
    w: 12.5,
    h: 0.3,
    fontFace: FONT,
    fontSize: 10,
    color: WHITE,
  });
}

const out = "Qlik-Observability-Toolkit-Architecture.pptx";
await pres.writeFile({ fileName: out });
console.log("wrote", out);
