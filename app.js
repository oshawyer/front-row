/* Front Row: static client. Reads data/items.json, data/voices.json, data/meta.json.
   v2 (25 Oct 2026): Industry and Relevance lens on Today, Feed, Podcasts and Voices (hash state, AND filtering),
   honest empty tiers, Transferable idea bridge, evidence labels, deterministic URL dedupe. Accepts v1 data (fields optional). */
(function () {
  "use strict";
  var S = { items: [], voices: [], meta: {}, byVoice: {}, voiceBySlug: {}, shown: 40, pubs: { today: {}, items: [], days: [] } };
  var TZ = "Australia/Adelaide";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var main = $("#main");

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function safeUrl(u) { return /^https?:\/\//i.test(u || "") ? u : "#"; }
  function edDate(d, opts) { if (!d) return ""; var x = new Date(d + "T12:00:00Z"); return x.toLocaleDateString("en-AU", Object.assign({ timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }, opts || {})); }
  function pubDay(iso) { if (!iso) return ""; var x = new Date(iso); if (isNaN(x)) return ""; return x.toLocaleDateString("en-AU", { timeZone: TZ, day: "numeric", month: "short" }); }
  function pubTime(iso) { if (!iso) return ""; var x = new Date(iso); if (isNaN(x)) return ""; return x.toLocaleTimeString("en-AU", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase(); }
  function localDay(iso) { var x = new Date(iso); if (isNaN(x)) return ""; return x.toLocaleDateString("en-CA", { timeZone: TZ }); }
  function mins(i) { return i.read_minutes ? i.read_minutes + (i.source_type === "Video" ? " min watch" : i.source_type === "Podcast" ? " min listen" : " min read") : ""; }
  /* canonical URL for display dedupe: strips tracking parameters only; parameters that identify content (?i= episode ids, ?p=) are kept */
  function canon(u) {
    try {
      var p = new URL(u), q = [];
      p.searchParams.forEach(function (v, k) { if (!/^(utm_|mc_|fbclid|gclid|ref$|r$|s$|uo$|publication_id|post_id|isfreemail|triedredirect)/i.test(k)) q.push(k + "=" + v); });
      return (p.hostname.replace(/^www\./, "") + p.pathname.replace(/\/+$/, "") + (q.length ? "?" + q.sort().join("&") : "")).toLowerCase();
    } catch (e) { return (u || "").toLowerCase(); }
  }
  function normTitle(t) { return (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
  function uniq(a) { return Array.from(new Set(a.filter(Boolean))).sort(function (x, y) { return x.localeCompare(y); }); }
  function hl(text, q) {
    var t = esc(text); if (!q) return t;
    q.split(/\s+/).filter(function (w) { return w.length > 1; }).forEach(function (w) {
      t = t.replace(new RegExp("(" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")(?![^<]*>)", "gi"), "<mark>$1</mark>");
    });
    return t;
  }
  function sortDay(i) { return i.backfill ? ((i.published && localDay(i.published)) || "") : (i.edition || ""); } // a backfill batch name is not a date
  function isPod(i) { return i.section === "podcasts" || i.source_type === "Podcast" || i.source_type === "Video"; }
  function written(list) { return list.filter(function (i) { return !isPod(i); }); }
  function voiceLink(i) { return '<a class="who" href="#/voice/' + esc(i.voice_slug) + '">' + esc(i.voice) + "</a>"; }
  function whoLine(i) { // a real byline that differs from the followed voice (shared feeds) is shown first, honestly
    return i.byline && i.byline !== i.voice ? '<span class="who">' + esc(i.byline) + '</span><span class="via">via ' + voiceLink(i).replace('class="who"', 'class="who sm"') + "</span>" : voiceLink(i);
  }

  /* ---------- industry and relevance lens (shared by Today, Feed, Podcasts, Voices) ---------- */
  var IND = [["sport", "Sport"], ["live-events-venues", "Live events & venues"], ["music-entertainment", "Music & entertainment"], ["media-creators", "Media & creators"], ["gaming-esports", "Gaming & esports"]];
  var INDL = {}; IND.forEach(function (x) { INDL[x[0]] = x[1]; });
  var REL = [["", "All approved"], ["direct", "Direct industry insight"], ["transferable", "Transferable idea"]];
  var G = { industry: "", relevance: "" };
  function readG(qs) { var p = new URLSearchParams(qs || ""); G.industry = INDL[p.get("industry")] ? p.get("industry") : ""; G.relevance = /^(direct|transferable)$/.test(p.get("relevance") || "") ? p.get("relevance") : ""; }
  function gQS() { var p = new URLSearchParams(); if (G.industry) p.set("industry", G.industry); if (G.relevance) p.set("relevance", G.relevance); return p.toString(); }
  function lensOn() { return !!(G.industry || G.relevance); }
  function matchG(i) {
    if (G.industry && (i.applies_to || []).indexOf(G.industry) < 0) return false;
    if (G.relevance && i.relevance_type !== G.relevance) return false;
    return true;
  }
  function matchGV(v) {
    if (G.industry && (v.industries || []).indexOf(G.industry) < 0) return false;
    if (G.relevance === "direct" && v.lane === "cross-industry") return false;
    if (G.relevance === "transferable" && v.lane !== "cross-industry") return false;
    return true;
  }
  function navSync() { // carry the lens between Today, Feed, Podcasts and Voices; never carry Feed-only filters
    var q = gQS();
    document.querySelectorAll("[data-nav]").forEach(function (a) {
      var base = { today: "#/", feed: "#/feed", podcasts: "#/podcasts", publications: "#/publications", voices: "#/voices", archive: "#/archive" }[a.dataset.nav];
      a.setAttribute("href", base + (q && a.dataset.nav !== "archive" ? "?" + q : ""));
    });
  }
  /* list: the items (or voices) in scope before the lens; isVoice switches the matcher */
  function lensBar(list, isVoice) {
    var m = isVoice ? matchGV : matchG, rel = G.relevance, ind = G.industry;
    function count(indId, relId) { var sI = G.industry, sR = G.relevance; G.industry = indId; G.relevance = relId; var n = list.filter(m).length; G.industry = sI; G.relevance = sR; return n; }
    var chips = [["", "All relevant insights"]].concat(IND).map(function (x) {
      var on = x[0] === ind, n = count(x[0], rel);
      return '<button type="button" class="chip' + (on ? " on" : "") + '" data-ind="' + x[0] + '" aria-pressed="' + on + '">' + (on ? '<span class="tick" aria-hidden="true">✓</span>' : "") + esc(x[1]) + ' <span class="n">' + n + "</span></button>";
    }).join("");
    var relSel = '<label class="rel"><span>Relevance</span><select id="g-rel" aria-label="Relevance">' + REL.map(function (r) {
      return '<option value="' + r[0] + '"' + (r[0] === rel ? " selected" : "") + ">" + esc(r[1]) + " (" + count(ind, r[0]) + ")</option>"; }).join("") + "</select></label>";
    var legacy = isVoice ? 0 : list.filter(function (i) { return i.relevance_type === "unreviewed"; }).length;
    return '<div class="lens" role="group" aria-label="Industry and relevance"><div class="chips" role="group" aria-label="Industry">' + chips + "</div>" +
      '<div class="lens-meta">' + relSel + (lensOn() ? '<button type="button" class="btn ghost" id="g-clear">Clear</button>' : "") +
      (lensOn() && legacy ? '<span class="lens-note">' + legacy + (legacy === 1 ? " earlier item is" : " earlier items are") + " not yet classified, so " + (legacy === 1 ? "it appears" : "they appear") + " only under All.</span>" : "") + "</div></div>";
  }
  function bindLens(rerender) {
    main.querySelectorAll(".chip[data-ind]").forEach(function (b) { b.addEventListener("click", function () { G.industry = b.dataset.ind; rerender(true); }); });
    var r = $("#g-rel"); if (r) r.addEventListener("change", function () { G.relevance = r.value; rerender(true); });
    var c = $("#g-clear"); if (c) c.addEventListener("click", function () { G.industry = ""; G.relevance = ""; rerender(true); });
  }
  function setHash(path, extra) { // path like "#/podcasts"; extra = other query params (Feed)
    var p = new URLSearchParams(extra || ""); if (G.industry) p.set("industry", G.industry); else p.delete("industry"); if (G.relevance) p.set("relevance", G.relevance); else p.delete("relevance");
    var h = path + (p.toString() ? "?" + p : ""); if (location.hash !== h) history.replaceState(null, "", h); navSync();
  }
  function refocus(sel) { var el = sel && main.querySelector(sel); if (el) el.focus({ preventScroll: true }); }
  var EMPTY = "No qualifying items for this selection. Clear a filter or browse earlier editions.";
  function badges(i) {
    var b = [];
    if (i.relevance_type === "transferable") {
      b.push('<span class="pill xfer">Transferable idea</span>');
      if ((i.applies_to || []).length) b.push('<span class="pill ind">Applies to ' + esc(i.applies_to.map(function (x) { return INDL[x]; }).join(", ").toLowerCase().replace(/^./, function (c) { return c; })) + "</span>");
    } else if (i.relevance_type === "direct") {
      (i.industries || []).slice().sort(function (a, b) { return (a === i.primary_industry ? -1 : 0) - (b === i.primary_industry ? -1 : 0); }).forEach(function (x) { b.push('<span class="pill ind">' + esc(INDL[x]) + "</span>"); });
    }
    if (i.evidence_level === "public_excerpt") b.push('<span class="pill acc">Summary based on public excerpt</span>');
    else if (i.evidence_level === "metadata_only") b.push('<span class="pill acc">Headline only</span>');
    else if (i.paywall) b.push('<span class="pill acc">Paywall</span>');
    if (i.edition === "pilot") b.push('<span class="pill pilot">Pilot sample · preview only</span>');
    if (i.backfill) b.push('<span class="pill past" title="Added in a one-off look-back. Shown with its original publication date; not part of any daily edition.">From the past month</span>');
    return b.length ? '<div class="badges">' + b.join("") + "</div>" : "";
  }
  function bridgeBlock(i) {
    if (i.relevance_type !== "transferable" || !i.bridge) return "";
    var rows = [["The idea", i.bridge.insight], ["Who could use it", i.bridge.decision], ["What changes here", i.bridge.adaptation], ["How to test it", i.bridge.test]];
    return '<details class="bridge"><summary>Why it transfers</summary><dl>' + rows.map(function (r) { return "<dt>" + r[0] + "</dt><dd>" + esc(r[1]) + "</dd>"; }).join("") + "</dl>" +
      (i.limitations ? '<p class="lim"><b>Limits</b> ' + esc(i.limitations) + "</p>" : "") + '<p class="lim muted">The application is Front Row\'s, not a claim that the author studied this industry.</p></details>';
  }

  /* ---------- dedupe: same canonical URL only, with an explicit deterministic preference ----------
     approved > unreviewed, better evidence, best read, tiered, higher rank, earliest edition (the original), id.
     Similar titles are NOT merged: two writers on the same story are separate analyses. Output keeps the input order. */
  var EVR = { full_text: 0, transcript: 1, show_notes: 2, public_excerpt: 3, metadata_only: 5 };
  function pref(a, b) {
    function k(i) { return [i.classification_status === "approved" ? 0 : 1, i.evidence_level in EVR ? EVR[i.evidence_level] : 4, i.best_of_day ? 0 : 1, i.tier ? 0 : 1, -(i.rank || 0)]; }
    var x = k(a), y = k(b); for (var n = 0; n < x.length; n++) if (x[n] !== y[n]) return x[n] - y[n];
    return (a.edition || "").localeCompare(b.edition || "") || String(a.id).localeCompare(String(b.id));
  }
  function dedupe(list) {
    var best = {}, also = {};
    list.forEach(function (i) { var k = canon(i.url); if (!best[k] || pref(i, best[k]) < 0) best[k] = i; (also[k] = also[k] || []).push(i.voice); });
    var out = [], done = {};
    list.forEach(function (i) {
      var k = canon(i.url); if (done[k] || best[k] !== i) return; done[k] = 1;
      out.push(Object.assign({}, i, { _also: uniq(also[k]).filter(function (v) { return v !== i.voice; }) }));
    });
    return out;
  }

  /* ---------- cards ---------- */
  function tierCard(i) {
    return '<article class="tcard' + (i.best_of_day ? " best" : "") + '">' + (i.best_of_day ? '<div class="bestflag">Best read of the day</div>' : "") +
      '<div class="byline">' + whoLine(i) + "</div>" + (i.role && !(i.byline && i.byline !== i.voice) ? '<div class="trole">' + esc(i.role) + "</div>" : "") +
      '<h3><a href="' + esc(safeUrl(i.url)) + '" target="_blank" rel="noopener">' + esc(i.title) + "</a></h3>" + badges(i) +
      (i.summary ? '<p class="sum">' + esc(i.summary) + "</p>" : "") +
      (i.why ? '<p class="why"><b>Why it matters</b>' + esc(i.why) + "</p>" : "") + bridgeBlock(i) +
      '<div class="byline"><span class="pill src">' + esc(i.source_type) + "</span>" + (mins(i) ? "<span>" + mins(i) + "</span>" : "") +
      '<a class="out" href="' + esc(safeUrl(i.url)) + '" target="_blank" rel="noopener">Read the original ↗</a></div></article>';
  }
  function podCard(i) {
    var pts = (i.key_points || []);
    return '<article class="pcard">' +
      '<div class="byline">' + whoLine(i) + '<span class="pill src">' + esc(i.source_type) + "</span>" + (mins(i) ? "<span>" + mins(i) + "</span>" : "") + "</div>" +
      (i.role ? '<div class="trole">' + esc(i.role) + "</div>" : "") +
      '<h3><a href="' + esc(safeUrl(i.url)) + '" target="_blank" rel="noopener">' + esc(i.title) + "</a></h3>" + badges(i) +
      (i.summary ? '<p class="sum"><b class="lab">What they argue</b>' + esc(i.summary) + "</p>" : "") +
      (pts.length ? '<div class="kp"><b class="lab">Key points</b><ul>' + pts.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul></div>" : "") +
      (i.why ? '<p class="why"><b>Why it matters</b>' + esc(i.why) + "</p>" : "") +
      '<a class="out" href="' + esc(safeUrl(i.url)) + '" target="_blank" rel="noopener">' + (i.source_type === "Video" ? "Watch" : "Listen") + " ↗</a></article>";
  }
  function podBlock(list, sub) {
    if (!list.length) return "";
    return '<section class="pods" aria-label="Podcasts worth listening to"><h2 class="sec">Podcasts worth listening to</h2><p class="sec-sub">' + esc(sub) + "</p>" +
      '<div class="pgrid">' + list.map(podCard).join("") + "</div></section>";
  }
  function row(i, q) {
    var tags = (i.themes || []).map(function (t) { return '<span class="pill theme">' + esc(t) + "</span>"; })
      .concat((i.disciplines || []).map(function (t) { return '<span class="pill">' + esc(t) + "</span>"; }));
    return '<li class="row"><div class="when"><b>' + esc(pubDay(i.published) || edDate(i.edition, { weekday: undefined, year: undefined })) + "</b>" + esc(pubTime(i.published)) + "</div><div>" +
      '<div class="byline">' + whoLine(i) + (i.region ? '<span class="dot">' + esc(i.region) + "</span>" : "") +
      '<span class="pill src">' + esc(i.source_type) + "</span>" + (mins(i) ? "<span>" + mins(i) + "</span>" : "") +
      (i.tier ? '<span class="tierflag" data-t="' + i.tier + '">' + "Must read</span>" : "") + "</div>" +
      '<h3><a href="' + esc(safeUrl(i.url)) + '" target="_blank" rel="noopener">' + hl(i.title, q) + "</a></h3>" + badges(i) +
      (i.summary ? '<p class="sum">' + hl(i.summary, q) + "</p>" : "") +
      (i.why ? '<p class="why"><b>Why it matters</b>' + esc(i.why) + "</p>" : "") + bridgeBlock(i) +
      '<a class="out" href="' + esc(safeUrl(i.url)) + '" target="_blank" rel="noopener">Read the original ↗</a>' +
      (i._also && i._also.length ? '<div class="also">Also picked up by ' + esc(i._also.join(", ")) + "</div>" : "") +
      (tags.length ? '<div class="tags">' + tags.join("") + "</div>" : "") + "</div></li>";
  }

  /* ---------- tiers for an edition ---------- */
  function tiersFor(ed) {
    var its = written(S.items.filter(function (i) { return i.edition === ed; }));
    var pods = S.items.filter(function (i) { return i.edition === ed && isPod(i); }).sort(function (a, b) { return b.rank - a.rank; });
    var t = { 1: [], 5: [], 10: [] };
    its.forEach(function (i) { if (i.tier) t[i.tier].push(i); });
    if (!t[1].length && !t[5].length && !t[10].length) { // fallback when the run has not tiered yet
      var r = its.slice().sort(function (a, b) { return b.rank - a.rank; });
      t[1] = r.slice(0, 2); t[5] = r.slice(2, 5); t[10] = r.slice(5, 8);
    }
    [1, 5, 10].forEach(function (k) { t[k].sort(function (a, b) { return (b.best_of_day ? 1 : 0) - (a.best_of_day ? 1 : 0) || b.rank - a.rank; }); });
    return { tiers: t, all: its, pods: pods };
  }
  function tierBlock(t) {
    var spec = [[1, "Got 1 minute", "The best written piece of the day first"], [5, "Got 5 minutes", "Add these next"], [10, "Got 10 minutes", "Go deeper"]];
    return '<p class="tier-note">' + esc(S.meta.tiers_note || "1, 5 and 10 are minutes of briefing time on this page, not the length of the original pieces.") + "</p>" +
      '<section class="tiers" aria-label="Must reads by time available">' + spec.map(function (s) {
      var list = t[s[0]].filter(matchG); // a filtered projection: no backfilling, ranks and the best-read badge stay as stored
      return '<div class="tier" data-t="' + s[0] + '"><div class="tier-head"><span class="big">' + s[0] + '</span><span class="lbl">' + s[1] + "<small>" + s[2] + "</small></span></div>" +
        (list.length ? list.map(tierCard).join("") : '<p class="empty">' + (lensOn() && t[s[0]].length ? "No qualifying items for this selection." : "Nothing in this tier today.") + "</p>") + "</div>";
    }).join("") + "</section>";
  }

  /* ---------- Best of the past month: a small, labelled look-back shelf on Today (never tiers, never today's news) ---------- */
  function pastShelf() {
    var seenV = {}, pool = dedupe(written(S.items.filter(function (i) { return i.backfill; })).filter(matchG).sort(function (a, b) { return b.rank - a.rank; }));
    var top = pool.filter(function (i) { if (seenV[i.voice]) return false; seenV[i.voice] = 1; return true; }).slice(0, 5);
    if (!top.length) return "";
    var days = S.items.filter(function (i) { return i.backfill && i.published; }).map(function (i) { return localDay(i.published); }).sort();
    var span = days.length ? pubDay(days[0] + "T12:00:00+10:30") + " to " + pubDay(days[days.length - 1] + "T12:00:00+10:30") : "the past month";
    return '<section class="past-shelf" aria-label="Best of the past month"><h2 class="sec">Best of the past month</h2><p class="sec-sub">A one-off look-back at strong pieces published ' + esc(span) +
      ", before the daily editions began. Each keeps its original date; none of it is today's news. " + '<a href="#/feed' + (gQS() ? "?" + gQS() : "") + '">More in the feed →</a></p>' +
      '<ul class="list">' + top.map(function (i) { return row(i); }).join("") + "</ul></section>";
  }

  /* ---------- views ---------- */
  function viewToday(qs) { viewEdition(S.meta.latest_edition, true, qs); }

  function viewEdition(ed, isToday, qs) {
    if (qs !== undefined) readG(qs);
    if (!ed) { main.innerHTML = '<p class="loading">No editions yet. The first one lands after the next nightly run.</p>'; return; }
    if ((S.meta.editions || []).indexOf(ed) < 0) { main.innerHTML = '<p class="loading">There is no edition for ' + esc(ed) + '. <a href="#/archive">Browse all editions</a>.</p>'; return; }
    var r = tiersFor(ed), tiered = {}, pb = pubBest(ed);
    if (pb) [1, 5, 10].forEach(function (k) { r.tiers[k] = r.tiers[k].map(function (i) { return i.best_of_day ? Object.assign({}, i, { best_of_day: false }) : i; }); });
    [1, 5, 10].forEach(function (k) { r.tiers[k].forEach(function (i) { tiered[i.id] = 1; }); });
    var scope = r.all.concat(r.pods);
    var all = r.all.filter(matchG), pods = r.pods.filter(matchG);
    var rest = dedupe(all.filter(function (i) { return !tiered[i.id]; }).sort(function (a, b) { return (b.published || "").localeCompare(a.published || ""); }));
    var voicesToday = uniq(all.concat(pods).map(function (i) { return i.voice; })).length;
    var none = lensOn() && !all.length && !pods.length;
    main.innerHTML =
      '<section class="hero"><div><p class="kicker">' + (isToday ? "Today's edition" : "Edition") + " · " + esc(edDate(ed)) + "</p>" +
      "<h1>" + (isToday ? "The sharpest thinking in sport, live and entertainment." : esc(edDate(ed, { weekday: "long" }))) + "</h1>" +
      '<p class="lede">Curated each morning from ' + (S.meta.voice_count || S.voices.length) + " individual voices across strategy, marketing, media, tech and what comes next. Start at the top and stop whenever you need to: the most valuable reads come first.</p></div>" +
      '<div class="stats" aria-live="polite"><div><b>' + all.length + "</b>reads</div><div><b>" + pods.length + "</b>podcasts</div><div><b>" + voicesToday + "</b>voices</div></div></section>" +
      lensBar(scope) +
      (none ? '<div class="empty-state" role="status"><p>' + EMPTY + '</p><p><button type="button" class="btn" id="g-clear2">Clear filters</button> <a class="btn" href="#/archive">Earlier editions</a></p></div>' : "") +
      (pb && matchG(pb) ? pubBestBlock(pb) : "") +
      tierBlock(r.tiers) +
      podBlock(pods, "Shows and videos with something real to say, summarised from their notes or transcripts. Kept apart from the reading list.") +
      '<h2 class="sec">Also in this edition</h2><p class="sec-sub">Every other written piece that passed the business filter, newest first. <a href="#/feed' + (gQS() ? "?" + gQS() : "") + '">Search the full feed →</a></p>' +
      (rest.length ? '<ul class="list">' + rest.map(function (i) { return row(i); }).join("") + "</ul>" : '<p class="empty">' + (lensOn() ? "No other qualifying items in this edition." : "That is everything for this edition.") + "</p>") +
      (isToday ? pastShelf() : '<a class="back" href="#/archive">← All editions</a>');
    var path = isToday ? "#/" : "#/edition/" + ed;
    bindLens(function () { setHash(path); viewEdition(ed, isToday); refocus(".chip.on"); });
    var c2 = $("#g-clear2"); if (c2) c2.addEventListener("click", function () { G.industry = ""; G.relevance = ""; setHash(path); viewEdition(ed, isToday); });
  }

  var F = { q: "", voice: "", region: "", disc: "", theme: "", src: "", from: "", to: "", must: "" };
  function readF(qs) { var p = new URLSearchParams(qs || ""); Object.keys(F).forEach(function (k) { F[k] = p.get(k) || ""; }); if (F.from && !/^\d{4}-\d{2}-\d{2}$/.test(F.from)) F.from = ""; if (F.to && !/^\d{4}-\d{2}-\d{2}$/.test(F.to)) F.to = ""; readG(qs); }
  function writeF() { var p = new URLSearchParams(); Object.keys(F).forEach(function (k) { if (F[k]) p.set(k, F[k]); }); setHash("#/feed", p.toString()); }
  function opt(list, val, label) { return '<option value="">' + label + "</option>" + list.map(function (v) { return '<option value="' + esc(v) + '"' + (v === val ? " selected" : "") + ">" + esc(v) + "</option>"; }).join(""); }

  function viewFeed(qs) {
    if (qs !== null) readF(qs); S.shown = 40;
    var it = written(S.items);
    main.innerHTML =
      '<section class="hero" style="padding-bottom:14px;border:0"><div><p class="kicker">The full feed</p><h1>Every written piece, newest first.</h1><p class="lede">Business of sport, live and entertainment only. Podcasts and video are in <a href="#/podcasts' + (gQS() ? "?" + gQS() : "") + '">Podcasts</a>.</p></div></section>' +
      lensBar(dedupe(it)) +
      '<div class="tools"><div class="searchbox"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
      '<input id="q" type="search" placeholder="Search titles, summaries and voices" value="' + esc(F.q) + '" autocomplete="off"></div>' +
      '<div class="filters">' +
      '<select id="f-voice" aria-label="Voice">' + opt(uniq(it.map(function (i) { return i.voice; })), F.voice, "All voices") + "</select>" +
      '<select id="f-region" aria-label="Region">' + opt(uniq(it.map(function (i) { return i.region; })), F.region, "All regions") + "</select>" +
      '<select id="f-disc" aria-label="Discipline">' + opt(uniq([].concat.apply([], it.map(function (i) { return i.disciplines || []; }))), F.disc, "All disciplines") + "</select>" +
      '<select id="f-theme" aria-label="Theme">' + opt(uniq([].concat.apply([], it.map(function (i) { return i.themes || []; }))), F.theme, "All themes") + "</select>" +
      '<select id="f-src" aria-label="Source type">' + opt(uniq(it.map(function (i) { return i.source_type; })), F.src, "All formats") + "</select>" +
      '<select id="f-must" aria-label="Must reads"><option value="">All items</option><option value="1"' + (F.must ? " selected" : "") + ">Must reads only</option></select>" +
      '<label>From <input id="f-from" type="date" value="' + esc(F.from) + '"></label><label>To <input id="f-to" type="date" value="' + esc(F.to) + '"></label>' +
      '<button class="btn" id="clear" type="button">Clear</button><span class="count" id="count" aria-live="polite"></span></div></div>' +
      '<ul class="list" id="results"></ul><div class="more" id="more"></div>';
    var map = { q: "#q", voice: "#f-voice", region: "#f-region", disc: "#f-disc", theme: "#f-theme", src: "#f-src", must: "#f-must", from: "#f-from", to: "#f-to" };
    Object.keys(map).forEach(function (k) {
      var el = $(map[k]); var ev = k === "q" ? "input" : "change"; var tmr;
      el.addEventListener(ev, function () { clearTimeout(tmr); tmr = setTimeout(function () { F[k] = el.value.trim(); S.shown = 40; writeF(); renderFeed(); }, k === "q" ? 120 : 0); });
    });
    $("#clear").addEventListener("click", function () { Object.keys(F).forEach(function (k) { F[k] = ""; }); G.industry = ""; G.relevance = ""; viewFeed(null); writeF(); });
    bindLens(function () { writeF(); viewFeed(null); refocus(".chip.on"); });
    renderFeed();
  }
  function filtered() {
    var words = F.q.toLowerCase().split(/\s+/).filter(Boolean);
    return dedupe(written(S.items).filter(function (i) {
      if (!matchG(i)) return false;
      if (F.voice && i.voice !== F.voice) return false;
      if (F.region && i.region !== F.region) return false;
      if (F.disc && (i.disciplines || []).indexOf(F.disc) < 0) return false;
      if (F.theme && (i.themes || []).indexOf(F.theme) < 0) return false;
      if (F.src && i.source_type !== F.src) return false;
      if (F.must && !i.tier) return false;
      var d = (i.published && localDay(i.published)) || i.edition;
      if (F.from && d < F.from) return false;
      if (F.to && d > F.to) return false;
      if (words.length) { var hay = (i.title + " " + i.summary + " " + i.voice + " " + i.why).toLowerCase(); for (var w = 0; w < words.length; w++) if (hay.indexOf(words[w]) < 0) return false; }
      return true;
    }));
  }
  function renderFeed() {
    var res = filtered(), box = $("#results");
    if (!box) return;
    $("#count").textContent = res.length + (res.length === 1 ? " item" : " items");
    box.innerHTML = res.length ? res.slice(0, S.shown).map(function (i) { return row(i, F.q); }).join("") : '<li class="empty" role="status">' + EMPTY + "</li>";
    var more = $("#more");
    more.innerHTML = res.length > S.shown ? '<button class="btn primary" type="button">Show more (' + (res.length - S.shown) + " left)</button>" : "";
    if (more.firstChild) more.firstChild.addEventListener("click", function () { S.shown += 40; renderFeed(); });
  }

  var VF = { q: "", region: "", tag: "" };
  function viewVoices(qs) {
    if (qs !== undefined) readG(qs);
    var tags = uniq([].concat.apply([], S.voices.map(function (v) { return v.tags || []; })));
    main.innerHTML =
      '<section class="hero" style="padding-bottom:14px;border:0"><div><p class="kicker">The voices</p><h1>Who we read, and why.</h1>' +
      '<p class="lede">' + S.voices.length + " individuals chosen for seniority, original thinking and relevance. Individuals, not publications. The industry filter shows each person's usual remit; their pieces are classified one by one.</p></div></section>" +
      lensBar(S.voices, true) +
      '<div class="tools"><div class="searchbox"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="vq" type="search" placeholder="Search names, roles and focus" value="' + esc(VF.q) + '"></div>' +
      '<div class="filters"><select id="vr" aria-label="Region">' + opt(uniq(S.voices.map(function (v) { return v.region; })), VF.region, "All regions") + "</select>" +
      '<select id="vt" aria-label="Focus">' + opt(tags, VF.tag, "All focus areas") + '</select><span class="count" id="vcount" aria-live="polite"></span></div></div><div class="vgrid" id="vgrid"></div>';
    bindLens(function () { setHash("#/voices"); viewVoices(); refocus(".chip.on"); });
    $("#vq").addEventListener("input", function (e) { VF.q = e.target.value.trim(); renderVoices(); });
    $("#vr").addEventListener("change", function (e) { VF.region = e.target.value; renderVoices(); });
    $("#vt").addEventListener("change", function (e) { VF.tag = e.target.value; renderVoices(); });
    renderVoices();
  }
  function renderVoices() {
    var q = VF.q.toLowerCase();
    var list = S.voices.filter(function (v) {
      if (!matchGV(v)) return false;
      if (VF.region && v.region !== VF.region) return false;
      if (VF.tag && (v.tags || []).indexOf(VF.tag) < 0) return false;
      if (q && (v.name + " " + v.role + " " + v.why + " " + (v.tags || []).join(" ")).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    $("#vcount").textContent = list.length + " voices";
    $("#vgrid").innerHTML = list.map(function (v) {
      var recent = (S.byVoice[v.slug] || []).slice(0, 3);
      return '<article class="vcard"><h3><a href="#/voice/' + esc(v.slug) + '">' + esc(v.name) + "</a></h3>" +
        '<p class="vrole">' + esc(v.role) + "</p>" +
        '<div class="tags"><span class="pill src">' + esc(v.region) + "</span>" + (v.lane === "cross-industry" ? '<span class="pill xfer">Cross-industry</span>' : "") + (v.industries || []).map(function (x) { return '<span class="pill ind">' + esc(INDL[x]) + "</span>"; }).join("") + (v.tags || []).map(function (t) { return '<span class="pill">' + esc(t) + "</span>"; }).join("") + "</div>" +
        (v.why ? '<p class="vwhy">' + esc(v.why) + "</p>" : "") +
        (recent.length ? '<ul class="vrecent">' + recent.map(function (i) { return '<li><span class="d">' + esc(pubDay(i.published)) + '</span><a href="' + esc(safeUrl(i.url)) + '" target="_blank" rel="noopener">' + esc(i.title) + "</a></li>"; }).join("") + "</ul>"
          : '<ul class="vrecent"><li class="muted">No items in the archive yet.</li></ul>') + "</article>";
    }).join("") || '<p class="empty" role="status">No voices match this selection. Clear a filter to see everyone.</p>';
  }

  function viewVoice(slug) {
    var v = S.voiceBySlug[slug], its = dedupe(S.byVoice[slug] || []);
    var name = v ? v.name : (its[0] && its[0].voice) || slug;
    var links = [];
    if (v) {
      (v.links || []).forEach(function (l) { try { links.push('<a href="' + esc(safeUrl(l)) + '" target="_blank" rel="noopener">' + esc(new URL(l).hostname.replace(/^www\./, "")) + " ↗</a>"); } catch (e) {} });
      if (v.linkedin) links.push('<a href="' + esc(safeUrl(v.linkedin)) + '" target="_blank" rel="noopener">LinkedIn ↗</a>');
      if (v.x) { var xh = String(v.x).replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").replace(/^@/, "").replace(/\/+$/, ""); if (/^[A-Za-z0-9_]{1,30}$/.test(xh)) links.push('<a href="https://x.com/' + esc(xh) + '" target="_blank" rel="noopener">X ↗</a>'); }
      links = links.map(function (l) { return l.replace(/>(?:[a-z]+\.)?linkedin\.com ↗</, ">LinkedIn ↗<"); });
      links = links.filter(function (l, k) { var lab = l.replace(/^.*>([^<]+)<\/a>$/, "$1"); return links.findIndex(function (m) { return m.replace(/^.*>([^<]+)<\/a>$/, "$1") === lab; }) === k; });
    }
    main.innerHTML = '<section class="vhead"><p class="kicker">Voice</p><h1>' + esc(name) + "</h1>" +
      (v ? '<p class="vrole" style="font-size:16px">' + esc(v.role) + " · " + esc(v.region) + "</p>" + (v.why ? '<p class="lede" style="color:var(--ink2);max-width:70ch">' + esc(v.why) + "</p>" : "") +
        ((v.industries || []).length || v.lane === "cross-industry" ? '<div class="tags">' + (v.lane === "cross-industry" ? '<span class="pill xfer">Cross-industry: pieces appear only as Transferable ideas</span>' : "") + (v.industries || []).map(function (x) { return '<span class="pill ind">' + esc(INDL[x]) + "</span>"; }).join("") + "</div>" : "") : "") +
      (links.length ? '<div class="links">' + links.join("") + "</div>" : "") + "</section>" +
      '<h2 class="sec">Recent items</h2><p class="sec-sub">' + its.length + " in the archive</p>" +
      (its.length ? '<ul class="list">' + its.map(function (i) { return row(i); }).join("") + "</ul>" : '<p class="empty">Nothing in the archive from this voice yet.</p>') +
      '<a class="back" href="#/voices">← All voices</a>';
  }

  function viewPodcasts(qs) {
    if (qs !== undefined) readG(qs);
    var scope = dedupe(S.items.filter(isPod).sort(function (a, b) { return sortDay(b).localeCompare(sortDay(a)) || (a.backfill ? 1 : 0) - (b.backfill ? 1 : 0) || b.rank - a.rank; }));
    var list = scope.filter(matchG);
    main.innerHTML = '<section class="hero" style="border:0;padding-bottom:6px"><div><p class="kicker">Podcasts</p><h1>Podcasts worth listening to.</h1><p class="lede">Each one summarised from its show notes or transcript: what was argued, the key points, and why it matters. Episodes without enough source text are left out.</p></div></section>' +
      lensBar(scope) + '<p class="count" aria-live="polite" style="margin:10px 0">' + list.length + (list.length === 1 ? " episode" : " episodes") + "</p>" +
      (list.length ? '<div class="pgrid">' + list.map(podCard).join("") + "</div>" : '<p class="empty" role="status">' + (scope.length ? EMPTY : "No podcasts picked yet.") + "</p>");
    bindLens(function () { setHash("#/podcasts"); viewPodcasts(); refocus(".chip.on"); });
  }
  function viewArchive() {
    var eds = S.meta.editions || [];
    main.innerHTML = '<section class="hero" style="border:0;padding-bottom:6px"><div><p class="kicker">Archive</p><h1>Every edition.</h1><p class="lede">Each morning\'s must reads and everything else that came in, kept by edition date.</p></div></section>' +
      '<div class="arch">' + eds.map(function (ed) {
        var r = tiersFor(ed), lead = r.tiers[1][0] || r.tiers[5][0] || r.all[0];
        return '<a class="ed" href="#/edition/' + esc(ed) + '"><div class="dte">' + esc(edDate(ed)) + '</div><div class="n">' + r.all.length + " items · " +
          uniq(r.all.map(function (i) { return i.voice; })).length + " voices</div>" + (lead ? '<div class="lead">Lead: ' + esc(lead.title) + " (" + esc(lead.voice) + ")</div>" : "") + "</a>";
      }).join("") + "</div>";
  }

  /* ---------- Publications: trade-press picks, kept apart from Voices (own data file, own page; never in tiers, Feed or the directory) ---------- */
  function pubBest(ed) { return S.pubs.items.filter(function (p) { return p.best_read && p.day === ed; })[0] || null; }
  function pubAccess(p) {
    if (p.paywall && p.evidence === "public_excerpt") return "Paywall · summary from the public excerpt";
    if (p.paywall) return "Paywall";
    return p.evidence === "public_excerpt" ? "Free to read · summary from the public excerpt" : "Free to read";
  }
  function pubBadges(p) {
    var b = [];
    if (p.relevance === "transferable") b.push('<span class="pill xfer">Transferable idea</span>');
    (p.industries || []).forEach(function (x) { if (INDL[x]) b.push('<span class="pill ind">' + esc(INDL[x]) + "</span>"); });
    b.push('<span class="pill acc">' + esc(pubAccess(p)) + "</span>");
    if (p.fixture) b.push('<span class="pill pilot">Test fixture · never deployed</span>');
    return '<div class="badges">' + b.join("") + "</div>";
  }
  function pubCard(p, lead) {
    return '<article class="pubcard' + (p.best_read ? " best" : "") + '">' + (p.best_read ? '<div class="bestflag">Best read of the day</div>' : "") +
      '<div class="byline"><span class="who pub">' + esc(p.publication) + "</span>" + (p.byline ? '<span class="dot">' + esc(p.byline) + "</span>" : "") +
      '<span class="dot">' + esc(pubDay(p.published)) + "</span>" + (p.pick === "jump" && !lead ? '<span class="pill jump">Top pick</span>' : "") + "</div>" +
      '<h3><a href="' + esc(safeUrl(p.url)) + '" target="_blank" rel="noopener">' + esc(p.title) + "</a></h3>" + pubBadges(p) +
      '<p class="sum">' + esc(p.summary) + "</p>" +
      (p.what_it_means ? '<p class="why"><b>What it means</b>' + esc(p.what_it_means) + "</p>" : "") +
      '<a class="out" href="' + esc(safeUrl(p.url)) + '" target="_blank" rel="noopener">Read at ' + esc(p.publication) + " ↗</a></article>";
  }
  function pubBestBlock(p) {
    return '<section class="pub-best" aria-label="Best read of the day, from the publications"><p class="kicker" style="margin:22px 0 8px">Best read of the day · from <a href="#/publications">Publications</a></p>' + pubCard(p, true) + "</section>";
  }
  var PF = { pub: "" };
  function adlToday() { return new Date().toLocaleDateString("en-CA", { timeZone: TZ }); }
  function viewPublications(qs) {
    if (qs !== undefined && qs !== null) { readG(qs); PF.pub = new URLSearchParams(qs).get("pub") || ""; }
    var P = S.pubs, t = P.today || {}, all = P.items;
    var names = uniq(all.map(function (p) { return p.publication; }));
    if (PF.pub && names.indexOf(PF.pub) < 0) PF.pub = "";
    var scope = all.filter(function (p) { return !PF.pub || p.publication === PF.pub; });
    var list = scope.filter(matchG);
    var fresh = t.day === adlToday() && t.status === "ok";
    var note = !fresh ? '<div class="empty-state pub-note" role="status"><p><b>Publications not updated today.</b> ' +
        (all.length ? "The picks below are from earlier days." : "Nothing has been published here yet. The first picks arrive with the next morning's trade-press scan.") + "</p></div>"
      : (t.published ? "" : '<div class="empty-state pub-note" role="status"><p>' + esc(t.note || "No publication picks passed today's checks.") + "</p></div>");
    var days = uniq(list.map(function (p) { return p.day; })).reverse();
    var body = days.map(function (d) {
      var its = list.filter(function (p) { return p.day === d; }).sort(function (a, b) { return (b.best_read ? 1 : 0) - (a.best_read ? 1 : 0) || (a.pick === "jump" ? 0 : 1) - (b.pick === "jump" ? 0 : 1) || a.rank - b.rank; });
      return '<section class="pub-day" aria-label="' + esc(edDate(d)) + '"><h2 class="sec">' + (d === adlToday() ? "Today · " : "") + esc(edDate(d)) + '</h2><p class="sec-sub">' + its.length + (its.length === 1 ? " pick" : " picks") + "</p>" +
        '<div class="pubgrid">' + its.map(function (p) { return pubCard(p); }).join("") + "</div></section>";
    }).join("");
    main.innerHTML = '<section class="hero" style="border:0;padding-bottom:6px"><div><p class="kicker">Publications</p><h1>The trade press, read for you.</h1>' +
      '<p class="lede">Up to ten picks a day, found by a morning scan of the trade press and news alerts. Each is summarised from the piece itself, with what it means for the business. Kept apart from Voices: these are publications, not individual writers. Updated every morning, weekends included.</p></div></section>' +
      note + lensBar(scope) +
      '<div class="filters pub-filters"><label>Publication <select id="p-pub" aria-label="Publication"><option value="">All publications (' + all.length + ")</option>" +
      names.map(function (n) { return '<option value="' + esc(n) + '"' + (n === PF.pub ? " selected" : "") + ">" + esc(n) + " (" + all.filter(function (p) { return p.publication === n; }).length + ")</option>"; }).join("") +
      '</select></label><span class="count" aria-live="polite">' + list.length + (list.length === 1 ? " pick" : " picks") + " · last " + (P.keep_days || 30) + " days</span></div>" +
      (list.length ? body : (all.length ? '<p class="empty" role="status">' + EMPTY.replace("browse earlier editions", "choose another publication") + "</p>" : "")) +
      '<p class="muted pub-foot">Picks link to the original publication; all rights stay with the publishers. Paywalled pieces are summarised only from what is publicly readable.</p>';
    function go() { setHash("#/publications", PF.pub ? "pub=" + encodeURIComponent(PF.pub) : ""); viewPublications(null); }
    bindLens(function () { go(); refocus(".chip.on"); });
    var ps = $("#p-pub"); if (ps) ps.addEventListener("change", function () { PF.pub = ps.value; go(); refocus("#p-pub"); });
  }

  /* ---------- router ---------- */
  function route() {
    var h = location.hash.replace(/^#\/?/, ""), parts = h.split("?"), path = parts[0].split("/");
    var key = path[0] || "today", qs = parts[1] || "";
    document.querySelectorAll("[data-nav]").forEach(function (a) { var on = a.dataset.nav === (key === "voice" ? "voices" : key === "edition" ? "archive" : key); a.classList.toggle("on", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    if (key === "feed") viewFeed(qs);
    else if (key === "voices") viewVoices(qs);
    else if (key === "voice") viewVoice(decodeURIComponent(path[1] || ""));
    else if (key === "archive") viewArchive();
    else if (key === "podcasts") viewPodcasts(qs);
    else if (key === "publications") viewPublications(qs);
    else if (key === "edition") viewEdition(path[1], path[1] === S.meta.latest_edition, qs);
    else viewToday(qs);
    navSync();
    var nv = $(".nav"), on = $(".nav a.on"); // phones: keep the current section visible in the sideways-scrolling nav
    if (nv && on && nv.scrollWidth > nv.clientWidth) { var l = on.offsetLeft - nv.offsetLeft; if (l < nv.scrollLeft || l + on.offsetWidth > nv.scrollLeft + nv.clientWidth) nv.scrollLeft = Math.max(0, l - 24); }
    if (key !== "feed" || !parts[1]) window.scrollTo(0, 0);
  }

  /* ---------- theme ---------- */
  $("#themeBtn").addEventListener("click", function () {
    var root = document.documentElement, cur = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    root.dataset.theme = cur === "dark" ? "light" : "dark";
    try { localStorage.setItem("fr-theme", root.dataset.theme); } catch (e) {}
  });

  /* ---------- boot ---------- */
  function j(u) { return fetch(u, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }); }
  // Publications load on their own and can never block Voices: a missing or broken file just shows the empty-state note.
  var pubsP = j("data/publications.json").catch(function () { return null; });
  Promise.all([j("data/items.json"), j("data/voices.json"), j("data/meta.json"), pubsP]).then(function (r) {
    S.items = r[0]; S.voices = r[1]; S.meta = r[2];
    if (r[3] && Array.isArray(r[3].items)) S.pubs = { today: r[3].today || {}, days: r[3].days || [], keep_days: r[3].keep_days, items: r[3].items.map(function (p) {
      return Object.assign({}, p, { applies_to: p.industries || [], relevance_type: p.relevance, industries: p.industries || [] }); }) };
    S.voices.forEach(function (v) { S.voiceBySlug[v.slug] = v; });
    S.items.forEach(function (i) { (S.byVoice[i.voice_slug] = S.byVoice[i.voice_slug] || []).push(i); });
    if (S.meta.sample) $("#sampleBanner").hidden = false;
    if (S.meta.preview) { var pb = $("#previewBanner"); if (pb) pb.hidden = false; }
    S.items = S.items.map(function (i) { // v1 data: optional v2 fields default safely; legacy items stay unreviewed
      return Object.assign({ applies_to: [], industries: [], relevance_type: "unreviewed", classification_status: "unreviewed", evidence_level: null, bridge: null }, i);
    });
    var src = S.meta.sources, health = $("#health");
    if (health && src && src.last_fetch) health.textContent = "Sources: " + src.rss_feeds_verified + " RSS feeds verified of " + src.rss_feeds_enabled + " enabled; last check " +
      src.last_fetch.ok + " ok, " + src.last_fetch.quiet + " quiet, " + src.last_fetch.failed + " failed." + (S.meta.build_status === "partial" ? " Some sources failed on the last run, so this edition may be incomplete." : "");
    if (S.meta.built) $("#builtAt").textContent = "Updated " + new Date(S.meta.built).toLocaleString("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) + " Adelaide time";
    window.addEventListener("hashchange", route); route();
  }).catch(function (e) { main.innerHTML = '<p class="loading">Could not load the feed data (' + esc(e.message) + ").</p>"; });
})();
