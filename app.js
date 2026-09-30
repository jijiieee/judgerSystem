const $ = (selector) => document.querySelector(selector);

let currentUser = null;
let currentProfile = null;
let events = [];
let currentAdminEventId = null;
let pollingTimer = null;
let scoresLoading = false;
const openJudgeTables = new Set(); // remembers which judge detail tables are expanded

/* ------------------------------------------------------------------ */
/* STARTUP                                                            */
/* ------------------------------------------------------------------ */

let judgeEmailEdited = false;

document.addEventListener("DOMContentLoaded", async () => {
  $("#login-form").addEventListener("submit", login);
  $("#logout-btn").addEventListener("click", logout);
  $("#event-form").addEventListener("submit", createEvent);
  $("#judge-form").addEventListener("submit", createJudge);

  // Auto-fill the judge email from the name (still editable)
  $("#judge-name").addEventListener("input", () => {
    if (judgeEmailEdited) return;
    const slug = $("#judge-name").value
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/^\.+|\.+$/g, "");
    $("#judge-email").value = slug ? `${slug}@sc.com` : "";
  });
  $("#judge-email").addEventListener("input", () => {
    judgeEmailEdited = $("#judge-email").value.trim() !== "";
  });
  $("#contestant-form").addEventListener("submit", createContestant);
  $("#criterion-form").addEventListener("submit", createCriterion);
  $("#event-status").addEventListener("change", updateEventStatus);

  $("#admin-event-select").addEventListener("change", async (e) => {
    currentAdminEventId = e.target.value || null;
    clearJudgeMessage();
    renderEventInfo();
    await refreshEventPanels();
  });

  // Admin tabs
  document.querySelectorAll(".tab").forEach(btn =>
    btn.addEventListener("click", () => showTab(btn.dataset.tab))
  );

  // Judge on/off switches (event delegation, the list is re-rendered often)
  $("#admin-judges").addEventListener("change", toggleJudgeActive);

  // Remember which <details> the admin opened (toggle doesn't bubble -> capture)
  $("#admin-scores").addEventListener("toggle", (e) => {
    const id = e.target?.dataset?.judge;
    if (!id) return;
    if (e.target.open) openJudgeTables.add(id);
    else openJudgeTables.delete(id);
  }, true);

  const { data } = await supabaseClient.auth.getSession();
  if (data.session) {
    await startApp(data.session.user);
  }
});

function showTab(name) {
  document.querySelectorAll(".tab").forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on);
  });
  document.querySelectorAll(".panel").forEach(p =>
    p.classList.toggle("hidden", p.id !== `tab-${name}`)
  );
}

//auth
async function login(e) {
  e.preventDefault();

  const message = $("#login-message");
  message.textContent = "";
  message.className = "form-message";

  const email = $("#login-email").value.trim();
  const password = $("#login-password").value;

  if (!email || !password) {
    message.textContent = "Please enter your email and password.";
    message.classList.add("error");
    return;
  }

  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    console.error(error);
    message.textContent = "Login failed. Please check your email and password.";
    message.classList.add("error");
    return;
  }

  message.textContent = "Login successful!";
  message.classList.add("success");
  await startApp(data.user);
}

async function logout() {
  stopPolling();
  await supabaseClient.auth.signOut();
  location.reload();
}

async function startApp(user) {
  currentUser = user;

  const { data: profile, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (error) {
    alert("Profile could not be loaded: " + error.message);
    return;
  }

  currentProfile = profile;

  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#user-label").textContent = `${profile.display_name} • ${profile.role}`;

  if (profile.role === "admin") {
    $("#admin-view").classList.remove("hidden");
    await loadAdmin();
    startPolling();
  } else if (profile.role === "judge") {
    $("#judge-view").classList.remove("hidden");
    await loadJudgeScoresheet();
  } else {
    alert("Unknown account role.");
  }
}

//admin events
function clearJudgeMessage() {
  const m = $("#judge-message");
  if (m) { m.textContent = ""; m.className = "form-message"; }
}

async function loadAdmin() {
  clearJudgeMessage();
  const { data, error } = await supabaseClient
    .from("events")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    alert(error.message);
    return;
  }

  events = data || [];

  const select = $("#admin-event-select");
  select.innerHTML = "";

  for (const event of events) {
    const option = document.createElement("option");
    option.value = event.id;
    option.textContent = `${event.name} (${event.status})`;
    select.appendChild(option);
  }

  if (!events.some(ev => ev.id === currentAdminEventId)) {
    currentAdminEventId = events[0]?.id || null;
  }
  if (currentAdminEventId) select.value = currentAdminEventId;

  renderEventInfo();
  await refreshEventPanels();
}

function currentEvent() {
  return events.find(ev => ev.id === currentAdminEventId) || null;
}

function renderEventInfo() {
  const event = currentEvent();
  const statusSelect = $("#event-status");

  if (!event) {
    $("#admin-event-info").textContent = "No events yet.";
    statusSelect.disabled = true;
    return;
  }

  statusSelect.disabled = false;
  statusSelect.value = event.status;
  $("#admin-event-info").textContent =
    event.status === "active"
      ? `Viewing: ${event.name} — judges can score now.`
      : `Viewing: ${event.name} — judges are locked out (status: ${event.status}).`;
}

async function createEvent(e) {
  e.preventDefault();

  const name = $("#event-name").value.trim();
  if (!name) return;

  const { data, error } = await supabaseClient
    .from("events")
    .insert({ name, status: "draft", created_by: currentUser.id })
    .select("id")
    .single();

  if (error) {
    alert(error.message);
    return;
  }

  $("#event-form").reset();
  $("#new-event").open = false;
  showTab("contestants"); // next step after creating an event
  currentAdminEventId = data.id; // jump straight to the new event
  await loadAdmin();
}

async function updateEventStatus(e) {
  const event = currentEvent();
  if (!event) return;

  const status = e.target.value;
  if (status === event.status) return;

  if (status !== "active" &&
      !confirm(`Set "${event.name}" to ${status}? Judges will be locked out. Their scores are kept.`)) {
    renderEventInfo(); // put the dropdown back
    return;
  }

  const { error } = await supabaseClient
    .from("events")
    .update({ status })
    .eq("id", event.id);

  if (error) {
    alert(error.message);
    renderEventInfo();
    return;
  }

  await loadAdmin();
}

async function refreshEventPanels() {
  if (!currentAdminEventId) {
    $("#admin-judges").innerHTML = "<p class='muted'>Create your first event.</p>";
    $("#admin-contestants").innerHTML = "<p class='muted'>Create your first event.</p>";
    $("#admin-criteria").innerHTML = "<p class='muted'>Create your first event.</p>";
    $("#admin-scores").innerHTML = "<p class='muted'>Create your first event.</p>";
    return;
  }

  await Promise.all([
    loadAdminJudges(),
    loadAdminContestants(),
    loadAdminCriteria(),
    loadAdminScores()
  ]);
}

//admin judges
async function createJudge(e) {
  e.preventDefault();

  const message = $("#judge-message");
  message.className = "form-message";
  message.textContent = "";

  if (!currentAdminEventId) {
    message.textContent = "Please select an event first.";
    message.classList.add("error");
    return;
  }

  const body = {
    event_id: currentAdminEventId,
    display_name: $("#judge-name").value.trim(),
    email: $("#judge-email").value.trim(),
    password: $("#judge-password").value
  };

  const button = $("#judge-form button[type=submit]");
  button.disabled = true;
  message.textContent = "Creating judge account...";

  const { data, error } = await supabaseClient.functions.invoke("create-judge", { body });

  button.disabled = false;

  let problem = data?.error || null;
  if (error) {
    problem = error.message;
    try {
      const details = await error.context.json();
      if (details?.error) problem = details.error;
    } catch (_) { /* keep generic message */ }
  }

  if (problem) {
    message.textContent = problem;
    message.classList.add("error");
    return;
  }

  message.textContent = `Judge "${body.display_name}" created. Share the email and password with them.`;
  message.classList.add("success");
  $("#judge-form").reset();
  judgeEmailEdited = false;
  await loadAdminJudges();
}

async function loadAdminJudges() {
  const eventId = currentAdminEventId;
  if (!eventId) return;

  const { data, error } = await supabaseClient
    .from("event_judges")
    .select("judge_id, active, judge:judge_id(display_name, email)")
    .eq("event_id", eventId);

  if (eventId !== currentAdminEventId) return;

  if (error) {
    $("#admin-judges").innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    return;
  }

  if (!data.length) {
    $("#admin-judges").innerHTML = "<p class='muted'>No judges yet for this event.</p>";
    return;
  }

  const rows = data
    .sort((a, b) => (a.judge?.display_name || "").localeCompare(b.judge?.display_name || ""))
    .map(row => `
      <tr>
        <td>${escapeHtml(row.judge?.display_name || "Unknown")}</td>
        <td>${escapeHtml(row.judge?.email || "")}</td>
        <td>
          <label class="switch">
            <input type="checkbox" data-judge-id="${row.judge_id}" ${row.active ? "checked" : ""}>
            <span>${row.active ? "Access on" : "Access off"}</span>
          </label>
        </td>
      </tr>
    `).join("");

  $("#admin-judges").innerHTML = `
    <table>
      <thead><tr><th>Judge</th><th>Login email</th><th>Access</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function toggleJudgeActive(e) {
  const box = e.target;
  if (!box.matches("input[data-judge-id]")) return;

  const { error } = await supabaseClient
    .from("event_judges")
    .update({ active: box.checked })
    .eq("event_id", currentAdminEventId)
    .eq("judge_id", box.dataset.judgeId);

  if (error) {
    alert(error.message);
    box.checked = !box.checked;
    return;
  }

  await loadAdminJudges();
}

//admin contestants
async function createContestant(e) {
  e.preventDefault();

  if (!currentAdminEventId) {
    alert("Please select an event first.");
    return;
  }

  const number = Number($("#contestant-number").value);
  const name = $("#contestant-name").value.trim();

  if (!number || !name) {
    alert("Please enter the contestant number and name.");
    return;
  }

  const { error } = await supabaseClient
    .from("contestants")
    .insert({ event_id: currentAdminEventId, number, name });

  if (error) {
    alert(error.message);
    return;
  }

  $("#contestant-number").value = "";
  $("#contestant-name").value = "";

  await Promise.all([loadAdminContestants(), loadAdminScores()]);
}

async function loadAdminContestants() {
  const eventId = currentAdminEventId;
  if (!eventId) return;

  const { data, error } = await supabaseClient
    .from("contestants")
    .select("id, number, name")
    .eq("event_id", eventId)
    .order("number");

  if (eventId !== currentAdminEventId) return;

  if (error) {
    $("#admin-contestants").innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    return;
  }

  if (!data.length) {
    $("#admin-contestants").innerHTML = "<p class='muted'>No contestants yet.</p>";
    return;
  }

  const rows = data.map(c => `
    <tr>
      <td>${c.number}</td>
      <td>${escapeHtml(c.name)}</td>
    </tr>
  `).join("");

  $("#admin-contestants").innerHTML = `
    <table>
      <thead><tr><th>No.</th><th>Contestant</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

//admin criteria
async function createCriterion(e) {
  e.preventDefault();

  if (!currentAdminEventId) {
    alert("Please select an event first.");
    return;
  }

  const name = $("#criterion-name").value.trim();
  const max_score = Number($("#criterion-max").value);

  if (!name || !(max_score > 0)) {
    alert("Please enter a criterion name and a max score above 0.");
    return;
  }

  const { error } = await supabaseClient
    .from("criteria")
    .insert({ event_id: currentAdminEventId, name, max_score });

  if (error) {
    alert(error.message);
    return;
  }

  $("#criterion-name").value = "";
  $("#criterion-max").value = "100";

  await Promise.all([loadAdminCriteria(), loadAdminScores()]);
}

async function loadAdminCriteria() {
  const eventId = currentAdminEventId;
  if (!eventId) return;

  const { data, error } = await supabaseClient
    .from("criteria")
    .select("id, name, max_score")
    .eq("event_id", eventId)
    .order("id");

  if (eventId !== currentAdminEventId) return;

  if (error) {
    $("#admin-criteria").innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    return;
  }

  if (!data.length) {
    $("#admin-criteria").innerHTML = "<p class='muted'>No criteria yet.</p>";
    return;
  }

  const rows = data.map(c => `
    <tr>
      <td>${escapeHtml(c.name)}</td>
      <td>${Number(c.max_score)}</td>
    </tr>
  `).join("");

  $("#admin-criteria").innerHTML = `
    <table>
      <thead><tr><th>Criterion</th><th>Max</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

//tabulation
async function loadAdminScores() {
  const eventId = currentAdminEventId;
  if (!eventId || scoresLoading) return;
  scoresLoading = true;

  try {
    const [contestantsRes, criteriaRes, judgesRes, scoresRes] = await Promise.all([
      supabaseClient.from("contestants")
        .select("id, number, name").eq("event_id", eventId).order("number"),
      supabaseClient.from("criteria")
        .select("id, name, max_score").eq("event_id", eventId).order("id"),
      supabaseClient.from("event_judges")
        .select("judge_id, active, judge:judge_id(display_name)").eq("event_id", eventId),
      supabaseClient.from("scores")
        .select("judge_id, contestant_id, criterion_id, score")
        .eq("event_id", eventId).range(0, 9999)
    ]);

    if (eventId !== currentAdminEventId) return; // admin switched events meanwhile

    const failed = [contestantsRes, criteriaRes, judgesRes, scoresRes].find(r => r.error);
    if (failed) {
      $("#admin-scores").innerHTML = `<p>${escapeHtml(failed.error.message)}</p>`;
      return;
    }

    renderResults(
      contestantsRes.data,
      criteriaRes.data,
      judgesRes.data,
      scoresRes.data
    );
  } finally {
    scoresLoading = false;
  }
}

function renderResults(contestants, criteria, judgeRows, scores) {
  const box = $("#admin-scores");

  if (!contestants.length || !criteria.length || !judgeRows.length) {
    const missing = [];
    if (!contestants.length) missing.push("contestants");
    if (!criteria.length) missing.push("criteria");
    if (!judgeRows.length) missing.push("judges");
    box.innerHTML = `<p class="muted">Add ${missing.join(", ")} to start the tabulation.</p>`;
    return;
  }

  const judges = judgeRows
    .map(j => ({
      id: j.judge_id,
      name: j.judge?.display_name || "Unknown Judge",
      active: j.active
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const scoreMap = new Map();
  for (const s of scores) {
    if (s.score !== null) {
      scoreMap.set(`${s.judge_id}:${s.contestant_id}:${s.criterion_id}`, Number(s.score));
    }
  }

  // Per contestant, per judge: how many criteria scored + the total.
  const results = contestants.map(c => {
    const perJudge = {};
    const completeTotals = [];

    for (const j of judges) {
      let total = 0;
      let count = 0;
      for (const k of criteria) {
        const v = scoreMap.get(`${j.id}:${c.id}:${k.id}`);
        if (v !== undefined) {
          total += v;
          count++;
        }
      }
      const complete = count === criteria.length;
      perJudge[j.id] = { total, count, complete };
      if (complete) completeTotals.push(total);
    }

    const average = completeTotals.length
      ? completeTotals.reduce((a, b) => a + b, 0) / completeTotals.length
      : null;

    return { contestant: c, perJudge, average, judgesDone: completeTotals.length };
  });

  // Rank: highest average first; equal averages share a rank (1, 2, 2, 4).
  const ranked = results
    .filter(r => r.average !== null)
    .sort((a, b) => b.average - a.average || a.contestant.number - b.contestant.number);

  ranked.forEach((r, i) => {
    const prev = ranked[i - 1];
    r.rank = prev && round2(prev.average) === round2(r.average) ? prev.rank : i + 1;
  });

  const unranked = results.filter(r => r.average === null);
  const ordered = [...ranked, ...unranked];

  const judgeHeaders = judges.map(j =>
    `<th>${escapeHtml(j.name)}${j.active ? "" : " <small class='muted'>(off)</small>"}</th>`
  ).join("");

  const rankRows = ordered.map(r => {
    const cells = judges.map(j => {
      const p = r.perJudge[j.id];
      if (p.complete) return `<td>${round2(p.total)}</td>`;
      if (p.count > 0) return `<td class="muted">${p.count}/${criteria.length} scored</td>`;
      return `<td class="muted">—</td>`;
    }).join("");

    return `
      <tr>
        <td><strong>${r.rank ?? "—"}</strong></td>
        <td>${r.contestant.number}</td>
        <td>${escapeHtml(r.contestant.name)}</td>
        ${cells}
        <td>${r.judgesDone}/${judges.length}</td>
        <td><strong>${r.average === null ? "—" : r.average.toFixed(2)}</strong></td>
      </tr>
    `;
  }).join("");

  const rankingTable = `
    <div class="table-scroll">
      <table class="ranking">
        <thead>
          <tr>
            <th>Rank</th><th>No.</th><th>Contestant</th>
            ${judgeHeaders}
            <th>Judges done</th><th>Average</th>
          </tr>
        </thead>
        <tbody>${rankRows}</tbody>
      </table>
    </div>
  `;

  // Per-judge detail (criterion by criterion)
  const totalCells = contestants.length * criteria.length;

  const detail = judges.map(j => {
    let entered = 0;

    const rows = contestants.map(c => {
      let total = 0;
      const cells = criteria.map(k => {
        const v = scoreMap.get(`${j.id}:${c.id}:${k.id}`);
        if (v === undefined) return `<td class="muted">—</td>`;
        entered++;
        total += v;
        return `<td>${v}</td>`;
      }).join("");

      return `
        <tr>
          <td>${c.number}. ${escapeHtml(c.name)}</td>
          ${cells}
          <td><strong>${round2(total)}</strong></td>
        </tr>
      `;
    }).join("");

    const open = openJudgeTables.has(j.id) ? "open" : "";

    return `
      <details class="judge-score-table" data-judge="${j.id}" ${open}>
        <summary>${escapeHtml(j.name)} — ${entered}/${totalCells} scores entered</summary>
        <div class="table-scroll">
          <table class="detail">
            <thead>
              <tr>
                <th>Contestant</th>
                ${criteria.map(k => `<th>${escapeHtml(k.name)}<br><small class="muted">max ${Number(k.max_score)}</small></th>`).join("")}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </details>
    `;
  }).join("");

  box.innerHTML = `
    <h4>Ranking</h4>
    ${rankingTable}
    <h4>Score details per judge</h4>
    ${detail}
  `;
}

//scoresheet
async function loadJudgeScoresheet() {
  const sheet = $("#judge-scoresheet");

  const { data: assignments, error: assignmentError } = await supabaseClient
    .from("event_judges")
    .select("event_id, events(name, status)")
    .eq("judge_id", currentUser.id)
    .eq("active", true);

  if (assignmentError) {
    sheet.innerHTML = `<p>${escapeHtml(assignmentError.message)}</p>`;
    return;
  }

  const assignment = (assignments || []).find(a => a.events?.status === "active");

  if (!assignment) {
    $("#judge-event-name").textContent = "Judge Scoresheet";
    sheet.innerHTML = `
      <p>There is no active event for your account right now.</p>
      <p class="muted">If judging should be open, ask the admin to set your event to Active.</p>
    `;
    return;
  }

  const eventId = assignment.event_id;
  $("#judge-event-name").textContent = assignment.events.name;

  const [contestantsRes, criteriaRes, scoresRes] = await Promise.all([
    supabaseClient.from("contestants")
      .select("id, name, number").eq("event_id", eventId).order("number"),
    supabaseClient.from("criteria")
      .select("id, name, max_score").eq("event_id", eventId).order("id"),
    supabaseClient.from("scores")
      .select("contestant_id, criterion_id, score")
      .eq("event_id", eventId).eq("judge_id", currentUser.id)
  ]);

  if (contestantsRes.error || criteriaRes.error || scoresRes.error) {
    sheet.innerHTML = "<p>Could not load the scoresheet.</p>";
    return;
  }

  const contestants = contestantsRes.data;
  const criteria = criteriaRes.data;

  if (!contestants.length || !criteria.length) {
    sheet.innerHTML = "<p class='muted'>The scoresheet is not ready yet. Please check back soon.</p>";
    return;
  }

  const scoreMap = new Map(
    scoresRes.data.map(s => [`${s.contestant_id}:${s.criterion_id}`, s.score])
  );

  let html = "<div class='table-scroll'><table class='scoresheet'><thead><tr><th>Contestant</th>";
  for (const k of criteria) {
    html += `<th>${escapeHtml(k.name)}<br><small>max ${Number(k.max_score)}</small></th>`;
  }
  html += "</tr></thead><tbody>";

  for (const c of contestants) {
    html += `<tr><td>${c.number}. ${escapeHtml(c.name)}</td>`;

    for (const k of criteria) {
      const saved = scoreMap.get(`${c.id}:${k.id}`);
      html += `
        <td data-label="${escapeHtml(k.name)} (max ${Number(k.max_score)})">
          <input
            class="score-input"
            type="number"
            min="0"
            max="${Number(k.max_score)}"
            step="0.01"
            value="${saved ?? ""}"
            data-event-id="${eventId}"
            data-contestant-id="${c.id}"
            data-criterion-id="${k.id}"
            data-max="${Number(k.max_score)}"
            placeholder="0-${Number(k.max_score)}"
          >
        </td>
      `;
    }

    html += "</tr>";
  }

  html += "</tbody></table></div>";
  sheet.innerHTML = html;

  document.querySelectorAll(".score-input").forEach(input => {
    input.addEventListener("change", saveScore);
  });
}

async function saveScore(e) {
  const input = e.target;
  const value = input.value === "" ? null : Number(input.value);
  const max = Number(input.dataset.max);

  input.classList.remove("saved", "error");

  if (value !== null && (Number.isNaN(value) || value < 0 || value > max)) {
    input.classList.add("error");
    alert(`Score must be between 0 and ${max}.`);
    return;
  }

  // One upsert handles both "first time" and "editing" - no duplicate rows.
  const { error } = await supabaseClient
    .from("scores")
    .upsert({
      event_id: input.dataset.eventId,
      judge_id: currentUser.id,
      contestant_id: input.dataset.contestantId,
      criterion_id: input.dataset.criterionId,
      score: value,
      submitted_at: new Date().toISOString()
    }, { onConflict: "event_id,judge_id,contestant_id,criterion_id" });

  if (error) {
    input.classList.add("error");
    if (error.code === "42501") {
      alert("Scoring for this event is closed. Your last change was not saved.");
    } else {
      alert("Score was not saved: " + error.message);
    }
    return;
  }

  input.classList.add("saved");
}

//poll
function startPolling() {
  stopPolling();
  pollingTimer = setInterval(() => {
    if (currentProfile?.role === "admin") {
      loadAdminScores();
    }
  }, 3000);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
