// Build the Talend TMC MCP architecture deck.
// Output: Talend-TMC-MCP-Architecture.pptx (at the project root).
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
pres.title = "Talend TMC MCP Architecture";
pres.author = "Talend TMC MCP Server";
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
  card(1.0, "315", "MCP tools", "Auto-generated from all 20 Talend Cloud OpenAPI specs.");
  card(4.7, "N+N", "tenants", "Multiple Talend + multiple Qlik tenants in one config.");
  card(8.4, "4", "Python exporters", "Business · Engine logs · QVD upload · Qlik observability.");
}

// ============================================================================
// Slide 2 — Architecture diagram
// ============================================================================
{
  const s = pres.addSlide();
  s.background = { color: BG_LIGHT };

  // Title
  s.addText("End-to-end data flow", {
    x: 0.5,
    y: 0.25,
    w: 12.3,
    h: 0.6,
    fontFace: FONT,
    fontSize: 26,
    color: TEAL_DEEP,
    bold: true,
  });
  s.addText("Where every metric, log line, and QVD row comes from and ends up.", {
    x: 0.5,
    y: 0.85,
    w: 12.3,
    h: 0.35,
    fontFace: FONT,
    fontSize: 13,
    color: MUTED,
  });

  // ----- Column 1: SOURCES (left) -----
  const colX = { src: 0.5, mid: 5.0, sink: 9.5 };
  const headerY = 1.5;
  const groupHeader = (x, y, w, label) => {
    s.addShape("rect", { x, y, w, h: 0.34, fill: { color: TEAL_DEEP } });
    s.addText(label, {
      x: x + 0.1,
      y: y + 0.02,
      w: w - 0.2,
      h: 0.3,
      fontFace: FONT,
      fontSize: 11,
      color: WHITE,
      bold: true,
      align: "left",
    });
  };
  const box = (x, y, w, h, title, sub, color, textColor = WHITE) => {
    s.addShape("roundRect", { x, y, w, h, fill: { color }, line: { type: "none" }, rectRadius: 0.06 });
    s.addText(title, {
      x: x + 0.12,
      y: y + 0.1,
      w: w - 0.24,
      h: 0.32,
      fontFace: FONT,
      fontSize: 13,
      color: textColor,
      bold: true,
      align: "left",
    });
    if (sub) {
      s.addText(sub, {
        x: x + 0.12,
        y: y + 0.45,
        w: w - 0.24,
        h: h - 0.5,
        fontFace: FONT,
        fontSize: 10,
        color: textColor,
        align: "left",
        valign: "top",
      });
    }
  };

  // Sources column
  groupHeader(colX.src, headerY, 4.2, "SOURCES");
  box(
    colX.src,
    headerY + 0.5,
    4.2,
    0.85,
    "Talend Cloud — N tenants",
    "Orchestration · Observability · Execution-history · Audit (per-tenant PAT)",
    PURPLE,
  );
  box(
    colX.src,
    headerY + 1.5,
    4.2,
    0.85,
    "Qlik Cloud — N tenants",
    "Apps · Reloads · Audit · Quotas (per-tenant API key)",
    QLIK_GREEN,
  );
  box(
    colX.src,
    headerY + 2.5,
    4.2,
    0.85,
    "Talend Remote Engine",
    "JSON job-management logs tailed from /data/log on Linux",
    TEAL_DEEP,
  );

  // Middle column — Exporters / MCP
  groupHeader(colX.mid, headerY, 4.0, "COLLECTORS");
  box(
    colX.mid,
    headerY + 0.5,
    4.0,
    0.85,
    "Talend TMC MCP server",
    "TS · stdio · observability preset (~10 tools) · /metrics",
    BLUE_DEEP,
  );
  box(
    colX.mid,
    headerY + 1.5,
    4.0,
    0.85,
    "Business exporter (Py)",
    "Polls all Talend tenants · /metrics:9465",
    BLUE_DEEP,
  );
  box(
    colX.mid,
    headerY + 2.5,
    4.0,
    0.85,
    "Engine log scraper (Py)",
    "Tails Remote Engine JSON logs · /metrics:9466",
    BLUE_DEEP,
  );
  box(
    colX.mid,
    headerY + 3.5,
    4.0,
    0.85,
    "Qlik observability exporter (Py)",
    "Polls all Qlik tenants · /metrics:9468",
    BLUE_DEEP,
  );

  // Sink column
  groupHeader(colX.sink, headerY, 3.4, "STORAGE + VIZ");
  box(
    colX.sink,
    headerY + 0.5,
    3.4,
    0.85,
    "Prometheus",
    "Scrapes all /metrics every 10s · 14d retention",
    SLATE,
  );
  box(
    colX.sink,
    headerY + 1.5,
    3.4,
    0.85,
    "Loki + Promtail",
    "JSON logs from every container · 7d retention",
    SLATE,
  );
  box(
    colX.sink,
    headerY + 2.5,
    3.4,
    0.85,
    "Grafana",
    "Pre-provisioned dashboards & datasources",
    TEAL_BRIGHT,
    SLATE,
  );
  box(
    colX.sink,
    headerY + 3.5,
    3.4,
    0.85,
    "Qlik Sense Cloud app",
    "Long-form QVD trend/correlation/BI",
    QLIK_GREEN,
  );

  // ----- Arrows (left -> middle -> right) -----
  // helper for a simple line arrow
  const arrow = (x1, y1, x2, y2, color = MUTED) => {
    s.addShape("line", {
      x: x1,
      y: y1,
      w: x2 - x1,
      h: y2 - y1,
      line: { color, width: 1.5, endArrowType: "triangle" },
    });
  };
  // Sources -> Collectors
  arrow(4.7, headerY + 0.92, 5.0, headerY + 0.92, PURPLE); // Talend -> MCP
  arrow(4.7, headerY + 0.92, 5.0, headerY + 1.92, PURPLE); // Talend -> Business
  arrow(4.7, headerY + 1.92, 5.0, headerY + 3.92, QLIK_GREEN); // Qlik -> Qlik obs exporter
  arrow(4.7, headerY + 2.92, 5.0, headerY + 2.92, TEAL_DEEP); // Engine logs -> scraper

  // Collectors -> Prometheus (4 lines into single sink)
  arrow(9.0, headerY + 0.92, 9.5, headerY + 0.92, MUTED);
  arrow(9.0, headerY + 1.92, 9.5, headerY + 0.92, MUTED);
  arrow(9.0, headerY + 2.92, 9.5, headerY + 0.92, MUTED);
  arrow(9.0, headerY + 3.92, 9.5, headerY + 0.92, MUTED);
  // Logs side -> Loki
  arrow(9.0, headerY + 0.92, 9.5, headerY + 1.92, BLUE_DEEP);

  // Prometheus -> Grafana
  arrow(11.2, headerY + 1.35, 11.2, headerY + 2.5, BLUE_DEEP);
  // Loki -> Grafana
  arrow(11.2, headerY + 2.35, 11.2, headerY + 2.5, BLUE_DEEP);
  // Prometheus -> Qlik Sense (via QVD exporter — annotated below)
  arrow(11.2, headerY + 1.35, 11.2, headerY + 3.5, QLIK_GREEN);

  // QVD bridge callout
  s.addShape("roundRect", {
    x: 5.0,
    y: headerY + 4.5,
    w: 8.1,
    h: 0.85,
    fill: { color: WHITE },
    line: { color: QLIK_GREEN, width: 1.5 },
    rectRadius: 0.06,
  });
  s.addText("Qlik QVD exporter (Py)", {
    x: 5.15,
    y: headerY + 4.6,
    w: 4.0,
    h: 0.32,
    fontFace: FONT,
    fontSize: 13,
    color: QLIK_GREEN,
    bold: true,
  });
  s.addText(
    "Prometheus PromQL → long-form (ts, metric, labels, value) → QVD via pyqvd → Qlik Cloud Data Files API → analyst-owned trend/correlation sheets.",
    {
      x: 5.15,
      y: headerY + 4.92,
      w: 7.85,
      h: 0.4,
      fontFace: FONT,
      fontSize: 10,
      color: SLATE,
    },
  );
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
      s.addText("RECOMMENDED IN OBSERVABILITY MODE", {
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
    "~9",
    "Pure read-only: observability-metrics, execution-logs, execution-history-search. Drops audit.",
    true,
  );
  presetCard(3.6, 1.5, "logging", "~10", "Same as observability + audit-logs (identity events).");
  presetCard(6.7, 1.5, "orchestrate", "~100", "Run things: orchestration tools + the observability trio.");
  presetCard(9.8, 1.5, "all", "315", "Every endpoint across all 20 TMC API products.");

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
    const y = 2.0 + row * 0.55;
    s.addText(r[0], { x, y, w: 2.6, h: 0.3, fontFace: FONT, fontSize: 11, color: TEAL_BRIGHT, bold: true });
    s.addText(r[1], { x: x + 2.6, y, w: 3.7, h: 0.3, fontFace: FONT, fontSize: 10, color: WHITE });
  });

  // Footer
  s.addShape("rect", { x: 0, y: 7.1, w: 13.333, h: 0.4, fill: { color: QLIK_GREEN } });
  s.addText("Talend TMC MCP · built on the Qlik stack · Inter typeface · #009845 / #006580 / #19416C", {
    x: 0.5,
    y: 7.16,
    w: 12.5,
    h: 0.3,
    fontFace: FONT,
    fontSize: 10,
    color: WHITE,
  });
}

const out = "Talend-TMC-MCP-Architecture.pptx";
await pres.writeFile({ fileName: out });
console.log("wrote", out);
