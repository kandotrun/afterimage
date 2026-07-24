export function renderAppPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>afterimage</title>
  <style>
    :root {
      --background:#f7f8fa;
      --surface:#ffffff;
      --surface-subtle:#f1f3f6;
      --text:#1d2026;
      --muted:#666d78;
      --line:#e1e4e9;
      --line-strong:#cfd4dc;
      --accent:#2563eb;
      --accent-hover:#1d4ed8;
      --accent-soft:#eff6ff;
      --success:#18794e;
      --warning:#9a6700;
      --danger:#b42318;
      --radius:12px;
      --control-radius:8px;
      --font:"Helvetica Neue","Hiragino Sans","Yu Gothic UI","Yu Gothic",sans-serif;
      --mono:"SFMono-Regular","Roboto Mono","Menlo",monospace;
    }
    * { box-sizing:border-box; }
    html { background:var(--background); }
    body { margin:0; min-width:320px; color:var(--text); background:var(--background); font:15px/1.65 var(--font); -webkit-font-smoothing:antialiased; }
    button,input { font:inherit; }
    button { cursor:pointer; }
    button:focus-visible,input:focus-visible,a:focus-visible { outline:3px solid rgb(37 99 235 / .24); outline-offset:2px; }
    .app { width:min(1120px,calc(100% - 40px)); margin:0 auto; padding-bottom:72px; }
    .app-header { min-height:68px; display:flex; align-items:center; justify-content:space-between; gap:20px; border-bottom:1px solid var(--line); }
    .brand { display:flex; align-items:baseline; gap:12px; min-width:0; }
    .brand h1 { margin:0; font-size:21px; line-height:1; font-weight:700; letter-spacing:-.02em; }
    .brand p { margin:0; color:var(--muted); font-size:13px; white-space:nowrap; }

    .filters { display:grid; grid-template-columns:170px minmax(220px,1fr) auto auto; gap:12px; align-items:end; padding:24px 0; border-bottom:1px solid var(--line); }
    .control { min-width:0; }
    .control label { display:block; margin-bottom:6px; color:var(--muted); font-size:12px; font-weight:600; }
    .control input { width:100%; min-height:44px; border:1px solid var(--line-strong); border-radius:var(--control-radius); background:var(--surface); color:var(--text); padding:9px 12px; transition:border-color .15s ease,box-shadow .15s ease; }
    .date-input { display:block; min-width:0; max-width:100%; width:100%; }
    @supports (-webkit-touch-callout:none) {
      .date-input { -webkit-appearance:none; appearance:none; overflow:hidden; }
      .date-input::-webkit-datetime-edit { display:block; min-width:0; width:100%; padding:0; }
    }
    .control input:hover { border-color:#aeb5c0; }
    .control input:focus { border-color:var(--accent); outline:0; box-shadow:0 0 0 3px rgb(37 99 235 / .12); }
    .control input::placeholder { color:#8c939e; }
    .button { min-height:44px; border:1px solid transparent; border-radius:var(--control-radius); padding:9px 16px; font-weight:650; white-space:nowrap; transition:background-color .15s ease,border-color .15s ease,transform .1s ease; }
    .button:active { transform:translateY(1px); }
    .button-primary { background:var(--accent); color:#fff; }
    .button-primary:hover { background:var(--accent-hover); }
    .button-secondary { border-color:var(--line-strong); background:var(--surface); color:var(--text); }
    .button-secondary:hover { background:var(--surface-subtle); }

    .summary { display:flex; align-items:baseline; justify-content:space-between; gap:20px; padding:28px 0 14px; }
    .summary h2 { margin:0; font-size:22px; line-height:1.3; font-weight:700; letter-spacing:-.02em; }
    .counts { color:var(--muted); font-size:13px; text-align:right; }
    .clip-list { display:grid; gap:16px; }

    .day-player { overflow:hidden; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); }
    .day-player-layout { display:grid; grid-template-columns:minmax(0,2fr) minmax(280px,.82fr); }
    .day-video-wrap { display:flex; align-items:center; min-width:0; padding:14px; background:#17191d; position:relative; }
    .canvasui-ripple-canvas { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; z-index:1; border-radius:var(--control-radius); }
    .day-video { display:block; width:100%; aspect-ratio:16/9; border-radius:var(--control-radius); background:#090a0c; object-fit:contain; }
    .day-sidebar { min-width:0; padding:20px; border-left:1px solid var(--line); }
    .day-player-head { display:flex; align-items:baseline; justify-content:space-between; gap:14px; padding-bottom:15px; border-bottom:1px solid var(--line); }
    .day-player-head h3 { margin:0; font-size:18px; line-height:1.3; letter-spacing:-.01em; }
    .day-total { flex:none; color:var(--muted); font:12px/1.5 var(--mono); }
    .live-transcript { margin-top:14px; padding:13px 14px; border:1px solid var(--line); border-radius:var(--control-radius); background:var(--surface-subtle); }
    .live-transcript-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:7px; }
    .live-transcript-label { margin:0; color:var(--muted); font-size:11px; font-weight:700; }
    .live-transcript-time { flex:none; color:var(--muted); font:11px/1.5 var(--mono); }
    .live-transcript-text { max-height:190px; margin:0; overflow:auto; overscroll-behavior:contain; color:#333842; font-size:13px; line-height:1.75; white-space:pre-wrap; overflow-wrap:anywhere; }
    .live-transcript.pending .live-transcript-text { color:var(--muted); }
    .chapter-list { display:grid; gap:6px; max-height:220px; margin-top:14px; overflow:auto; overscroll-behavior:contain; }
    .chapter-button { width:100%; display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px 12px; min-height:58px; border:1px solid transparent; border-radius:var(--control-radius); background:transparent; color:var(--text); padding:8px 10px; text-align:left; }
    .chapter-button:hover { background:var(--surface-subtle); }
    .chapter-button.active { border-color:#bfdbfe; background:var(--accent-soft); color:var(--accent-hover); }
    .chapter-time { display:block; font-size:14px; font-weight:700; font-variant-numeric:tabular-nums; }
    .chapter-file { display:block; overflow:hidden; color:var(--muted); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
    .chapter-duration { color:var(--muted); font:11px/1.4 var(--mono); }
    .clip-details { overflow:hidden; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); }
    .clip-details > summary { display:flex; align-items:center; justify-content:space-between; min-height:56px; padding:12px 16px; font-weight:650; list-style:none; cursor:pointer; }
    .clip-details > summary::-webkit-details-marker { display:none; }
    .clip-details > summary::after { content:"Show"; color:var(--muted); font-size:12px; font-weight:600; }
    .clip-details[open] > summary { border-bottom:1px solid var(--line); }
    .clip-details[open] > summary::after { content:"Hide"; }
    .detail-count { margin-left:8px; color:var(--muted); font-size:12px; font-weight:500; }
    .detail-list { display:grid; gap:12px; padding:14px; background:var(--background); }

    .clip-card { display:grid; grid-template-columns:minmax(280px,360px) minmax(0,1fr); overflow:hidden; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); }
    .clip-media { min-width:0; padding:14px; background:var(--surface-subtle); border-right:1px solid var(--line); }
    .clip-media video { display:block; width:100%; aspect-ratio:16/9; border-radius:var(--control-radius); background:#17191d; object-fit:contain; }
    .media-meta { display:flex; flex-wrap:wrap; gap:4px 14px; margin-top:10px; color:var(--muted); font:12px/1.5 var(--mono); }
    .clip-content { min-width:0; display:flex; flex-direction:column; padding:20px 22px; }
    .clip-head { display:flex; justify-content:space-between; align-items:flex-start; gap:18px; }
    .clip-time { margin:0; font-size:21px; line-height:1.2; font-weight:700; font-variant-numeric:tabular-nums; letter-spacing:-.02em; }
    .filename { margin:5px 0 0; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
    .status { flex:none; margin-top:2px; color:var(--muted); font-size:12px; font-weight:650; }
    .status.completed { color:var(--success); }
    .status.processing { color:var(--warning); }
    .status.error { color:var(--danger); }
    .transcript-label { margin:18px 0 6px; color:var(--muted); font-size:12px; font-weight:650; }
    .transcript { margin:0; color:#333842; font-size:14px; line-height:1.8; white-space:pre-wrap; overflow-wrap:anywhere; }
    .transcript.collapsed { display:-webkit-box; overflow:hidden; -webkit-box-orient:vertical; -webkit-line-clamp:6; }
    .pending-copy { color:var(--muted); }
    .transcript-toggle { align-self:flex-start; margin:8px 0 0; border:0; background:transparent; color:var(--accent); padding:2px 0; font-size:13px; font-weight:650; }
    .transcript-toggle:hover { color:var(--accent-hover); text-decoration:underline; text-underline-offset:3px; }
    .actions { display:flex; flex-wrap:wrap; gap:16px; margin-top:auto; padding-top:18px; }
    .text-link { color:var(--muted); font-size:13px; font-weight:600; text-decoration:none; }
    .text-link:hover { color:var(--accent); }

    .loading-list { display:grid; gap:16px; }
    .skeleton-card { display:grid; grid-template-columns:minmax(280px,360px) minmax(0,1fr); min-height:250px; overflow:hidden; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); }
    .skeleton-media,.skeleton-copy { position:relative; overflow:hidden; }
    .skeleton-media { margin:14px; border-radius:var(--control-radius); background:#e7e9ed; }
    .skeleton-copy { margin:24px 22px; background:linear-gradient(#e7e9ed 0 0) 0 0/38% 20px no-repeat,linear-gradient(#eff0f2 0 0) 0 48px/100% 13px no-repeat,linear-gradient(#eff0f2 0 0) 0 76px/92% 13px no-repeat,linear-gradient(#eff0f2 0 0) 0 104px/76% 13px no-repeat; }
    .skeleton-media::after,.skeleton-copy::after { content:""; position:absolute; inset:0; transform:translateX(-100%); background:linear-gradient(90deg,transparent,rgb(255 255 255 / .64),transparent); animation:shimmer 1.5s infinite; }
    @keyframes shimmer { to { transform:translateX(100%); } }
    .empty,.error-state { border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); padding:52px 24px; text-align:center; }
    .empty h3,.error-state h3 { margin:0 0 7px; font-size:17px; }
    .empty p,.error-state p { margin:0 auto; max-width:520px; color:var(--muted); }
    .error-state .button { margin-top:18px; }

    .toast { position:fixed; right:20px; bottom:20px; z-index:20; display:none; max-width:min(380px,calc(100% - 40px)); border-radius:var(--control-radius); background:#25282e; color:#fff; padding:11px 14px; font-size:13px; box-shadow:0 8px 28px rgb(30 35 45 / .18); }
    .toast.visible { display:block; }

    @media (max-width:860px) {
      .filters { grid-template-columns:170px minmax(180px,1fr); }
      .button { width:100%; }
      .day-player-layout,.clip-card,.skeleton-card { grid-template-columns:1fr; }
      .day-sidebar { border-top:1px solid var(--line); border-left:0; }
      .clip-media { border-right:0; border-bottom:1px solid var(--line); }
      .skeleton-card { min-height:450px; }
      .skeleton-media { min-height:250px; }
    }
    @media (max-width:600px) {
      .app { width:min(100% - 24px,1120px); padding-bottom:48px; }
      .app-header { min-height:60px; }
      .brand p { display:none; }
      .filters { grid-template-columns:1fr; gap:12px; padding:18px 0; }
      .summary { align-items:flex-start; padding:22px 0 12px; }
      .summary h2 { font-size:19px; }
      .counts { max-width:140px; }
      .clip-list,.loading-list { gap:12px; }
      .day-video-wrap { padding:8px; }
      .day-sidebar { padding:16px; }
      .live-transcript-text { max-height:170px; }
      .chapter-button { min-height:54px; }
      .detail-list { padding:10px; }
      .clip-media { padding:10px; }
      .clip-content { padding:17px 16px; }
      .clip-head { gap:12px; }
      .clip-time { font-size:19px; }
      .transcript-label { margin-top:15px; }
      .actions { padding-top:16px; }
      .skeleton-card { min-height:390px; }
      .skeleton-media { min-height:210px; margin:10px; }
      .toast { right:12px; bottom:12px; max-width:calc(100% - 24px); }
    }
    @media (prefers-reduced-motion:reduce) {
      * { animation:none!important; transition:none!important; scroll-behavior:auto!important; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="app-header">
      <div class="brand"><h1>afterimage</h1><p>videos &amp; transcripts</p></div>
    </header>

    <form class="filters" id="searchForm" aria-label="Filter videos">
      <div class="control">
        <label for="dateInput">Date</label>
        <input class="date-input" id="dateInput" type="date">
      </div>
      <div class="control">
        <label for="queryInput">Keyword</label>
        <input id="queryInput" type="search" placeholder="Search conversations and places" autocomplete="off">
      </div>
      <button class="button button-primary" type="submit">Search</button>
      <button class="button button-secondary" id="memoryButton" type="button">Copy day context</button>
    </form>

    <section class="summary" aria-labelledby="dayTitle">
      <h2 id="dayTitle">Videos</h2>
      <div class="counts" id="counts">Loading</div>
    </section>

    <main class="clip-list" id="clips" aria-live="polite" aria-busy="true">
      <div class="loading-list" aria-hidden="true">
        <article class="skeleton-card"><div class="skeleton-media"></div><div class="skeleton-copy"></div></article>
        <article class="skeleton-card"><div class="skeleton-media"></div><div class="skeleton-copy"></div></article>
      </div>
    </main>
  </div>

  <div class="toast" id="toast" role="status"></div>

  <script type="module">
    const state = { entries: [], playback: null };
    const $ = (selector) => document.querySelector(selector);
    const clips = $("#clips");
    const dateInput = $("#dateInput");
    const queryInput = $("#queryInput");

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function toast(message) {
      const node = $("#toast");
      node.textContent = message;
      node.classList.add("visible");
      clearTimeout(toast.timer);
      toast.timer = setTimeout(() => node.classList.remove("visible"), 3600);
    }
    function formatDuration(seconds) {
      const value = Math.max(0, Math.round(Number(seconds) || 0));
      return String(Math.floor(value / 60)).padStart(2,"0") + ":" + String(value % 60).padStart(2,"0");
    }
    function formatBytes(bytes) {
      const value = Number(bytes) || 0;
      if (!value) return "";
      const units = ["B","KB","MB","GB","TB"];
      let n = value, i = 0;
      while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
      return n.toFixed(i > 1 ? 1 : 0) + " " + units[i];
    }
    function localTime(value) {
      if (!value) return "Unknown time";
      return new Intl.DateTimeFormat(undefined, {
        hour:"2-digit",
        minute:"2-digit",
        second:"2-digit"
      }).format(new Date(value));
    }
    function formatDay(value) {
      if (!value) return "All dates";
      const parts = value.split("-").map(Number);
      if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return value;
      return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString(undefined, { year:"numeric", month:"long", day:"numeric" });
    }
    function statusLabel(status) {
      return ({ completed:"Transcribed", processing:"Processing", pending:"Pending", error:"Error" })[status] || "Pending";
    }
    function showLoading() {
      clips.setAttribute("aria-busy","true");
      clips.replaceChildren();
      const list = el("div","loading-list");
      list.setAttribute("aria-hidden","true");
      for (let index = 0; index < 2; index++) {
        const card = el("article","skeleton-card");
        card.append(el("div","skeleton-media"),el("div","skeleton-copy"));
        list.append(card);
      }
      clips.append(list);
      $("#counts").textContent = "Loading";
    }
    function showError(message, retry) {
      clips.setAttribute("aria-busy","false");
      clips.replaceChildren();
      const box = el("section","error-state");
      box.append(el("h3","","Cannot load entries"),el("p","",message));
      const button = el("button","button button-secondary","Try again");
      button.type = "button";
      button.addEventListener("click",retry);
      box.append(button);
      clips.append(box);
      $("#counts").textContent = "Error";
    }
    function createClipCard(item,index,{ search=false,prefix="clip" }={}) {
      const status = ["completed","processing","pending","error"].includes(item.status) ? item.status : "pending";
      const card = el("article","clip-card");
      card.setAttribute("aria-label",item.filename || "Video");

      const media = el("div","clip-media");
      const video = document.createElement("video");
      video.controls = true;
      video.preload = "none";
      video.playsInline = true;
      video.title = "Play " + (item.filename || "video");
      video.src = item.previewUrl || item.videoUrl;
      if (item.thumbnailUrl) video.poster = item.thumbnailUrl;
      media.append(video);
      const mediaMeta = el("div","media-meta");
      [
        formatDuration(item.durationSeconds),
        formatBytes(item.sizeBytes),
        item.width && item.height ? item.width + "×" + item.height : ""
      ].filter(Boolean).forEach((text) => mediaMeta.append(el("span","",text)));
      media.append(mediaMeta);
      card.append(media);

      const content = el("div","clip-content");
      const head = el("div","clip-head");
      const heading = el("div","");
      heading.append(el("h3","clip-time",localTime(item.capturedAt)),el("p","filename",item.filename || "Unknown file"));
      head.append(heading,el("span","status " + status,statusLabel(status)));
      content.append(head);

      const transcriptText = item.snippet || item.transcript?.text || (item.error ? "Processing error: " + item.error : "Transcription in progress.");
      const hasTranscript = Boolean(item.snippet || item.transcript?.text);
      content.append(el("p","transcript-label",search ? "Match" : "Transcript"));
      const transcript = el("p","transcript" + (hasTranscript ? "" : " pending-copy"),transcriptText);
      transcript.id = prefix + "-transcript-" + index;
      if (transcriptText.length > 240) transcript.classList.add("collapsed");
      content.append(transcript);
      if (transcriptText.length > 240) {
        const toggle = el("button","transcript-toggle","Show full text");
        toggle.type = "button";
        toggle.setAttribute("aria-controls",transcript.id);
        toggle.setAttribute("aria-expanded","false");
        toggle.addEventListener("click",() => {
          const expanded = toggle.getAttribute("aria-expanded") === "true";
          toggle.setAttribute("aria-expanded",String(!expanded));
          transcript.classList.toggle("collapsed",expanded);
          toggle.textContent = expanded ? "Show full text" : "Collapse";
        });
        content.append(toggle);
      }

      const actions = el("div","actions");
      const source = el("a","text-link","Open video");
      source.href = item.videoUrl;
      source.target = "_blank";
      source.rel = "noreferrer";
      actions.append(source);
      if (item.id) {
        const detail = el("a","text-link","View JSON");
        detail.href = "/api/entries/" + encodeURIComponent(item.id);
        detail.target = "_blank";
        detail.rel = "noreferrer";
        actions.append(detail);
      }
      content.append(actions);
      card.append(content);
      return card;
    }
    function renderDayPlayer(playback,items) {
      const card = el("section","day-player");
      card.setAttribute("aria-label","Day player");
      const layout = el("div","day-player-layout");
      const media = el("div","day-video-wrap");
      const video = document.createElement("video");
      video.className = "day-video";
      video.controls = true;
      video.preload = "metadata";
      video.playsInline = true;
      video.src = playback.videoUrl;
      video.title = "Play day video";
      if (playback.posterUrl) video.poster = playback.posterUrl;
      media.append(video);
      layout.append(media);

      const sidebar = el("div","day-sidebar");
      const head = el("div","day-player-head");
      head.append(
        el("h3","","Day player"),
        el("span","day-total",playback.clipCount + " clips / " + formatDuration(playback.durationSeconds))
      );
      sidebar.append(head);
      const entryById = new Map(items.map((item) => [item.id,item]));
      const liveTranscript = el("section","live-transcript");
      liveTranscript.setAttribute("aria-label","Now playing transcript");
      liveTranscript.setAttribute("aria-live","off");
      const liveTranscriptHead = el("div","live-transcript-head");
      const liveTranscriptLabel = el("p","live-transcript-label","Now playing");
      const liveTranscriptTime = el("span","live-transcript-time","");
      liveTranscriptHead.append(liveTranscriptLabel,liveTranscriptTime);
      const liveTranscriptText = el("p","live-transcript-text","");
      liveTranscriptText.tabIndex = 0;
      liveTranscript.append(liveTranscriptHead,liveTranscriptText);
      sidebar.append(liveTranscript);
      const chapterList = el("div","chapter-list");
      chapterList.setAttribute("aria-label","Chapters");
      const buttons = [];
      let activeChapterIndex = -1;

      function showChapterTranscript(chapter,index) {
        const entry = entryById.get(chapter.id) || items.find((item) => item.filename === chapter.filename);
        const text = entry?.transcript?.text || (entry?.error ? "Processing error: " + entry.error : "Transcription in progress.");
        const hasTranscript = Boolean(entry?.transcript?.text);
        liveTranscriptTime.textContent = localTime(chapter.capturedAt);
        liveTranscriptText.textContent = text;
        liveTranscriptText.scrollTop = 0;
        liveTranscript.classList.toggle("pending",!hasTranscript);
        liveTranscript.dataset.chapterIndex = String(index);
      }
      function setActive(activeIndex) {
        if (activeIndex === activeChapterIndex) return;
        activeChapterIndex = activeIndex;
        buttons.forEach((button,index) => {
          const active = index === activeIndex;
          button.classList.toggle("active",active);
          if (active) button.setAttribute("aria-current","true");
          else button.removeAttribute("aria-current");
        });
        const chapter = playback.chapters[activeIndex];
        if (chapter) showChapterTranscript(chapter,activeIndex);
      }
      function playChapter(chapter,index) {
        const seek = () => {
          video.currentTime = Number(chapter.startSeconds) || 0;
          setActive(index);
          const pending = video.play();
          if (pending?.catch) pending.catch(() => {});
        };
        if (video.readyState >= 1) seek();
        else {
          video.addEventListener("loadedmetadata",seek,{ once:true });
          video.load();
        }
      }

      playback.chapters.forEach((chapter,index) => {
        const button = el("button","chapter-button");
        button.type = "button";
        button.dataset.startSeconds = String(chapter.startSeconds);
        button.setAttribute("aria-label","Play from " + localTime(chapter.capturedAt));
        const label = el("span","");
        label.append(el("span","chapter-time",localTime(chapter.capturedAt)),el("span","chapter-file",chapter.filename));
        button.append(label,el("span","chapter-duration",formatDuration(chapter.durationSeconds)));
        button.addEventListener("click",() => playChapter(chapter,index));
        buttons.push(button);
        chapterList.append(button);
      });
      if (buttons.length) setActive(0);
      video.addEventListener("timeupdate",() => {
        let active = 0;
        for (let index = 0; index < playback.chapters.length; index++) {
          if (video.currentTime >= Number(playback.chapters[index].startSeconds || 0)) active = index;
          else break;
        }
        setActive(active);
      });
      sidebar.append(chapterList);
      layout.append(sidebar);
      card.append(layout);
      return card;
    }
    async function enhanceVideoWithRipple(surface) {
      if (window.matchMedia("(prefers-reduced-motion:reduce)").matches) return;
      try {
        const { createRipple } = await import("/assets/canvasui-ripple.mjs");
        const output = document.createElement("canvas");
        output.className = "canvasui-ripple-canvas";
        output.setAttribute("aria-hidden", "true");
        surface.append(output);
        const sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = 1;
        sourceCanvas.height = 1;
        const instance = createRipple(
          { source: sourceCanvas, content: surface, output },
          { amplitude: 0.4, speed: 0.55, wavelength: 100, rings: 3, decay: 1.0, refraction: 70, dispersion: 0.35, shine: 0.5, trigger: "click", interval: 0 }
        );
        if (!instance) { output.remove(); return; }
        requestAnimationFrame(() => instance.resize());
        const ro = new ResizeObserver(() => instance.resize());
        ro.observe(surface);
      } catch { /* WebGL2 unavailable - normal UI */ }
    }
    const searchParams = new URLSearchParams(location.search);
    const canvasUiEnabled = searchParams.get("canvasui") === "1";
    function render(items, { search=false,total=items.length,query="",playback=null }={}) {
      clips.setAttribute("aria-busy","false");
      clips.replaceChildren();
      $("#dayTitle").textContent = search ? "Results for \\"" + query + "\\"" : formatDay(dateInput.value);
      const completed = items.filter((item) => item.transcript?.text || item.snippet).length;
      $("#counts").textContent = total + " clips (" + completed + " transcribed)";
      if (!items.length) {
        const empty = el("section","empty");
        empty.append(
          el("h3","",search ? "No results found" : "No videos for this date"),
          el("p","",search ? "Try a different keyword." : "Videos will appear here once added.")
        );
        clips.append(empty);
        return;
      }

      if (!search && playback?.videoUrl) {
        const playerCard = renderDayPlayer(playback,items);
        clips.append(playerCard);
        if (canvasUiEnabled) {
          const surface = playerCard.querySelector(".day-video-wrap");
          if (surface) enhanceVideoWithRipple(surface);
        }
        const details = document.createElement("details");
        details.className = "clip-details";
        const summary = document.createElement("summary");
        const label = el("span","","Individual clips");
        label.append(el("span","detail-count",items.length + " clips"));
        summary.append(label);
        details.append(summary);
        const list = el("div","detail-list");
        items.forEach((item,index) => list.append(createClipCard(item,index,{ prefix:"detail" })));
        details.append(list);
        clips.append(details);
        return;
      }

      items.forEach((item,index) => clips.append(createClipCard(item,index,{ search,prefix:search ? "search" : "clip" })));
    }
    async function api(url, options={}) {
      const response = await fetch(url,options);
      if (!response.ok) throw new Error((await response.text()) || "request_failed");
      return response.status === 204 ? null : response.json();
    }
    async function loadEntries() {
      showLoading();
      const suffix = dateInput.value ? "?date=" + encodeURIComponent(dateInput.value) : "";
      try {
        const body = await api("/api/entries" + suffix);
        state.entries = body.items;
        state.playback = body.playback || null;
        if (!dateInput.value && body.items.length) {
          dateInput.value = body.items[body.items.length - 1].date;
          return loadEntries();
        }
        render(body.items,{ playback:body.playback });
      } catch (error) {
        showError("Check your connection and try again.",loadEntries);
        toast("Failed to load entries: " + error.message);
      }
    }
    $("#searchForm").addEventListener("submit",async(event) => {
      event.preventDefault();
      const query = queryInput.value.trim();
      if (!query) return loadEntries();
      showLoading();
      try {
        const body = await api("/api/search?q=" + encodeURIComponent(query) + (dateInput.value ? "&date=" + encodeURIComponent(dateInput.value) : ""));
        render(body.items,{ search:true,total:body.total,query });
      } catch (error) {
        showError("Search failed. Please try again.",() => $("#searchForm").requestSubmit());
        toast("Search failed: " + error.message);
      }
    });
    $("#memoryButton").addEventListener("click",async() => {
      if (!dateInput.value) return toast("Select a date first.");
      const button = $("#memoryButton");
      const label = button.textContent;
      button.disabled = true;
      button.textContent = "Copying…";
      try {
        const body = await api("/api/memory?date=" + encodeURIComponent(dateInput.value));
        await navigator.clipboard.writeText(body.markdown || "");
        button.textContent = "Copied!";
        toast("Day context copied to clipboard.");
      } catch (error) {
        button.textContent = label;
        toast("Copy failed: " + error.message);
      } finally {
        setTimeout(() => { button.disabled = false; button.textContent = label; },1200);
      }
    });
    dateInput.addEventListener("change",() => {
      queryInput.value = "";
      loadEntries();
    });
    loadEntries();
  </script>
</body>
</html>`;
}
