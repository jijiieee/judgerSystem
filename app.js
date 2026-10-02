const $ = (selector) => document.querySelector(selector);

let currentUser = null;
let currentProfile = null;
let events = [];
let currentAdminEventId = null;
let pollingTimer = null;
let scoresLoading = false;
let scoresLoadStartedAt = 0;
let scoresTicket = 0;
const openJudgeTables = new Set();
const openJudgeCategories = new Set();
let judgeEmailEdited = false;
let judgeRows = new Map();
let currentResultsCache = null;
let judgeCategoryIndex = Number(localStorage.getItem("sc_judge_category_index") || 0);

function restoreUiState() {
  try {
    const tabs = JSON.parse(localStorage.getItem("sc_open_judge_tables") || "[]");
    const cats = JSON.parse(localStorage.getItem("sc_open_judge_categories") || "[]");
    tabs.forEach(id => openJudgeTables.add(String(id)));
    cats.forEach(key => openJudgeCategories.add(String(key)));
  } catch (_) {}
}

function persistUiState() {
  localStorage.setItem("sc_open_judge_tables", JSON.stringify([...openJudgeTables]));
  localStorage.setItem("sc_open_judge_categories", JSON.stringify([...openJudgeCategories]));
  localStorage.setItem("sc_judge_category_index", String(judgeCategoryIndex));
  const activeTab = document.querySelector(".tab.active")?.dataset.tab;
  if (activeTab) localStorage.setItem("sc_active_tab", activeTab);
}

/* ------------------------------------------------------------------ */
/* STARTUP                                                            */
/* ------------------------------------------------------------------ */

document.addEventListener("DOMContentLoaded", async () => {
  restoreUiState();
  try {
  $("#login-form").addEventListener("submit", login);
  $("#logout-btn").addEventListener("click", logout);
  $("#new-event-btn").addEventListener("click", openEventDialog);
  $("#judge-form").addEventListener("submit", createJudge);
  $("#contestant-form").addEventListener("submit", createContestant);
  $("#add-category-btn").addEventListener("click", () => openCategoryDialog());
  $("#event-status").addEventListener("change", updateEventStatus);
  $("#event-numbering-mode").addEventListener("change", updateEventNumberingMode);
  $("#admin-judges").addEventListener("change", toggleJudgeActive);
  $("#admin-scores").addEventListener("toggle", (e) => {
    const id = e.target?.dataset?.judge;
    if (!id) return;
    if (e.target.open) openJudgeTables.add(id);
    else openJudgeTables.delete(id);
    persistUiState();
  }, true);
  $("#admin-scores").addEventListener("toggle", (e) => {
    const key = e.target?.dataset?.judgeCategoryKey;
    if (!key) return;
    if (e.target.open) openJudgeCategories.add(key);
    else openJudgeCategories.delete(key);
    persistUiState();
  }, true);

  $("#admin-categories").addEventListener("submit", async (e) => {
    const form = e.target.closest("form[data-category-id]");
    if (!form) return;
    await createCriterion(e);
  });
  $("#admin-categories").addEventListener("click", async (e) => {
    const edit = e.target.closest("[data-edit-category]");
    if (edit) return openCategoryDialog(edit.dataset.editCategory);
    const del = e.target.closest("[data-delete-category]");
    if (del) return deleteCategory(del.dataset.deleteCategory);
    const editCriterionBtn = e.target.closest("[data-edit-criterion]");
    if (editCriterionBtn) return editCriterion(editCriterionBtn.dataset.editCriterion);
    const deleteCriterionBtn = e.target.closest("[data-delete-criterion]");
    if (deleteCriterionBtn) return deleteCriterion(deleteCriterionBtn.dataset.deleteCriterion);
  });

  $("#admin-event-select").addEventListener("change", async (e) => {
    currentAdminEventId = e.target.value || null;
    clearJudgeMessage();
    renderEventInfo();
    await refreshEventPanels();
  });

  $("#refresh-results")?.addEventListener("click", () => loadAdminScores({ force: true }));
  const refreshIfAdmin = () => { if (currentProfile?.role === "admin" && !document.hidden) loadAdminScores({ force: true }); };
  document.addEventListener("visibilitychange", refreshIfAdmin);
  window.addEventListener("focus", refreshIfAdmin);
  window.addEventListener("online", refreshIfAdmin);

  document.querySelectorAll(".tab").forEach(btn =>
    btn.addEventListener("click", () => showTab(btn.dataset.tab))
  );

  $("#judge-name").addEventListener("input", () => {
    if (judgeEmailEdited) return;
    const slug = $("#judge-name").value
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
    $("#judge-email").value = slug ? `${slug}@sc.com` : "";
  });
  $("#judge-email").addEventListener("input", () => {
    judgeEmailEdited = $("#judge-email").value.trim() !== "";
  });

  } catch (err) {
    console.error("UI setup failed:", err);
  }

  const { data } = await supabaseClient.auth.getSession();
  if (data.session) await startApp(data.session.user);

  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (event === "SIGNED_OUT") {
      stopPolling();
      return;
    }
    if ((event === "SIGNED_IN" || event === "TOKEN_REFRESHED") && session?.user && !currentUser) {
      await startApp(session.user);
    } else if (session?.user && currentUser && session.user.id !== currentUser.id) {
      // Another tab of this browser signed in as someone else; this tab would now
      // be reading data as that account. Stop and reload instead of showing wrong data.
      stopPolling();
      await notify("A different account signed in from another tab of this browser, so this page was signed out. Use a separate browser or an incognito window for each account.", "Signed in elsewhere");
      location.reload();
    }
  });
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
  localStorage.setItem("sc_active_tab", name);
}

/* ------------------------------------------------------------------ */
/* AUTH                                                               */
/* ------------------------------------------------------------------ */

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
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    message.textContent = "Login failed. Please check your email and password.";
    message.classList.add("error");
    return;
  }
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
    .from("profiles").select("*").eq("id", user.id).single();
  if (error) {
    notify("Profile could not be loaded: " + error.message);
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
    notify("Unknown account role.");
  }
}

/* ------------------------------------------------------------------ */
/* ADMIN EVENTS                                                       */
/* ------------------------------------------------------------------ */

function clearJudgeMessage() {
  const m = $("#judge-message");
  if (m) { m.textContent = ""; m.className = "form-message"; }
}

async function loadAdmin() {
  clearJudgeMessage();
  const { data, error } = await supabaseClient
    .from("events").select("*").order("created_at", { ascending: false });
  if (error) { notify(error.message, ERR_TITLE); return; }
  events = data || [];
  const select = $("#admin-event-select");
  select.innerHTML = "";
  for (const event of events) {
    const option = document.createElement("option");
    option.value = event.id;
    option.textContent = `${event.name} (${event.status})`;
    select.appendChild(option);
  }
  if (!events.some(ev => ev.id === currentAdminEventId)) currentAdminEventId = events[0]?.id || null;
  if (currentAdminEventId) select.value = currentAdminEventId;
  renderEventInfo();
  await refreshEventPanels();
  const savedTab = localStorage.getItem("sc_active_tab");
  if (savedTab && document.querySelector(`.tab[data-tab="${savedTab}"]`)) showTab(savedTab);
}

function currentEvent() {
  return events.find(ev => ev.id === currentAdminEventId) || null;
}

function renderEventInfo() {
  const event = currentEvent();
  const statusSelect = $("#event-status");
  const active = event?.status === "active";
  $("#contestant-form")?.classList.toggle("disabled-form", active);
  $("#contestant-form")?.querySelectorAll("input,button").forEach(el => el.disabled = active);
  $("#contestant-lock-note")?.classList.toggle("hidden", !active);

  if (!event) {
    $("#admin-event-info").innerHTML = `<span>No events yet. Create one to get started.</span>`;
    statusSelect.disabled = true;
    return;
  }
  statusSelect.disabled = false;
  statusSelect.value = event.status;
  const numbering = $("#event-numbering-mode");
  numbering.disabled = active;
  numbering.value = event.numbering_mode || "unique";
  const byDivision = (event.numbering_mode || "unique") === "by_division";
  $("#contestant-division")?.closest(".field")?.classList.toggle("hidden", !byDivision);
  $("#contestant-division")?.toggleAttribute("required", byDivision);
  $("#contestant-numbering-note").textContent = byDivision
    ? "This event allows the same contestant number in different divisions. Enter a division only when needed."
    : "Each contestant number must be unique in this event. No division is needed.";
  $("#admin-event-info").innerHTML = active
    ? `${statusBadge("active")}<span>Judges can score now. Contestants and scoring setup are locked.</span>`
    : `${statusBadge(event.status)}<span>Judges are locked out.</span>`;
}

async function openEventDialog() {
  let newId = null;
  const saved = await formDialog({
    title: "New event",
    description: "Next you can add contestants, scoring categories and judges.",
    fields: [{ name: "name", label: "Event name", required: true, placeholder: "e.g. Mr. & Ms. University 2026" }],
    submitText: "Create event",
    onSubmit: async (v) => {
      const { data, error } = await supabaseClient.from("events")
        .insert({ name: v.name, status: "draft", created_by: currentUser.id, numbering_mode: "unique" })
        .select("id").single();
      if (error) return error.message;
      newId = data.id;
    }
  });
  if (!saved) return;
  currentAdminEventId = newId;
  showTab("contestants");
  await loadAdmin();
  toast("Event created.");
}

async function updateEventNumberingMode(e) {
  const event = currentEvent();
  if (!event || isEventActive()) { renderEventInfo(); return; }
  const numbering_mode = e.target.value === "by_division" ? "by_division" : "unique";
  const { error } = await supabaseClient.from("events").update({ numbering_mode }).eq("id", event.id);
  if (error) { notify(error.message, ERR_TITLE); renderEventInfo(); return; }
  await loadAdmin();
}

async function updateEventStatus(e) {
  const event = currentEvent();
  if (!event) return;
  const status = e.target.value;
  if (status === event.status) return;
  if (status !== "active") {
    const ok = await confirmDialog({
      title: `Set event to ${status}?`,
      message: `"${event.name}" will be marked ${status}. Judges will be locked out, and their scores are kept.`,
      confirmText: `Set to ${status}`
    });
    if (!ok) { renderEventInfo(); return; }
  }
  const { error } = await supabaseClient.from("events").update({ status }).eq("id", event.id);
  if (error) { notify(error.message, ERR_TITLE); renderEventInfo(); return; }
  await loadAdmin();
}

async function refreshEventPanels() {
  if (!currentAdminEventId) {
    $("#admin-judges").innerHTML = "<p class='muted'>Create your first event.</p>";
    $("#admin-contestants").innerHTML = "<p class='muted'>Create your first event.</p>";
    $("#admin-categories").innerHTML = "<p class='muted'>Create your first event.</p>";
    $("#admin-scores").innerHTML = "<p class='muted'>Create your first event.</p>";
    return;
  }
  await Promise.all([loadAdminJudges(), loadAdminContestants(), loadAdminCategories(), loadAdminScores()]);
}

function isEventActive() { return currentEvent()?.status === "active"; }

/* ------------------------------------------------------------------ */
/* ADMIN JUDGES                                                       */
/* ------------------------------------------------------------------ */

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
    try { const details = await error.context.json(); if (details?.error) problem = details.error; } catch (_) {}
  }
  if (problem) { message.textContent = problem; message.classList.add("error"); return; }
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
    .from("event_judges").select("judge_id, active, judge:judge_id(display_name, email)").eq("event_id", eventId);
  if (eventId !== currentAdminEventId) return;
  if (error) { $("#admin-judges").innerHTML = `<p>${escapeHtml(error.message)}</p>`; return; }
  if (!data.length) { $("#admin-judges").innerHTML = "<p class='muted'>No judges yet for this event.</p>"; return; }
  judgeRows = new Map(data.map(r => [r.judge_id, { name: r.judge?.display_name || "", email: r.judge?.email || "" }]));
  const rows = data.sort((a,b) => (a.judge?.display_name||"").localeCompare(b.judge?.display_name||"")).map(row => `
    <tr>
      <td>${escapeHtml(row.judge?.display_name || "Unknown")}</td>
      <td>${escapeHtml(row.judge?.email || "")}</td>
      <td><label class="switch"><input type="checkbox" data-judge-id="${row.judge_id}" ${row.active ? "checked" : ""}><span>${row.active ? "Access on" : "Access off"}</span></label></td>
      <td class="actions"><button class="secondary small-btn" type="button" data-edit-judge="${row.judge_id}">Edit</button><button class="danger-small" type="button" data-remove-judge="${row.judge_id}">Remove</button></td>
    </tr>`).join("");
  $("#admin-judges").innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr><th>Judge</th><th>Login email</th><th>Access</th><th class="col-actions"></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  $("#admin-judges").querySelectorAll("[data-edit-judge]").forEach(btn => btn.addEventListener("click", () => editJudge(btn.dataset.editJudge)));
  $("#admin-judges").querySelectorAll("[data-remove-judge]").forEach(btn => btn.addEventListener("click", () => removeJudge(btn.dataset.removeJudge)));
}

async function toggleJudgeActive(e) {
  const box = e.target;
  if (!box.matches("input[data-judge-id]")) return;
  const { error } = await supabaseClient.from("event_judges").update({ active: box.checked })
    .eq("event_id", currentAdminEventId).eq("judge_id", box.dataset.judgeId);
  if (error) { notify(error.message, ERR_TITLE); box.checked = !box.checked; return; }
  await loadAdminJudges();
}

async function editJudge(judgeId) {
  const current = judgeRows.get(judgeId);
  if (!current) return;
  const saved = await formDialog({
    title: "Edit judge",
    description: "Changes apply to this judge's login for the whole system.",
    fields: [
      { name: "name", label: "Judge name", value: current.name, required: true },
      { name: "email", label: "Login email", value: current.email, required: true, inputType: "email" },
      { name: "password", label: "New password", raw: true, placeholder: "Leave blank to keep the current password",
        hint: "Only fill this in to reset the judge's password (min. 6 characters)." }
    ],
    submitText: "Save changes",
    onSubmit: async (v) => {
      if (v.password && v.password.length < 6) return "Password must be at least 6 characters.";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) return "Enter a valid email address.";
      const body = { judge_id: judgeId };
      if (v.name !== current.name) body.display_name = v.name;
      if (v.email.toLowerCase() !== current.email.toLowerCase()) body.email = v.email;
      if (v.password) body.password = v.password;
      if (Object.keys(body).length === 1) return null; // nothing changed
      const { data, error } = await supabaseClient.functions.invoke("update-judge", { body });
      let problem = data?.error || null;
      if (error) {
        problem = error.message;
        try { const details = await error.context.json(); if (details?.error) problem = details.error; } catch (_) {}
      }
      return problem;
    }
  });
  if (!saved) return;
  await Promise.all([loadAdminJudges(), loadAdminScores()]);
  toast("Judge updated.");
}

async function removeJudge(judgeId) {
  const ok = await confirmDialog({
    title: "Remove judge?",
    message: "This judge will be removed from the event. Their existing scores are kept.",
    confirmText: "Remove",
    danger: true
  });
  if (!ok) return;
  const { error } = await supabaseClient.from("event_judges").delete()
    .eq("event_id", currentAdminEventId).eq("judge_id", judgeId);
  if (error) { notify(error.message, ERR_TITLE); return; }
  await Promise.all([loadAdminJudges(), loadAdminScores()]);
  toast("Judge removed.");
}

/* ------------------------------------------------------------------ */
/* ADMIN CONTESTANTS                                                  */
/* ------------------------------------------------------------------ */

async function createContestant(e) {
  e.preventDefault();
  if (!currentAdminEventId) { notify("Please select an event first."); return; }
  if (isEventActive()) { notify("Contestants cannot be added while the event is Active."); return; }
  const number = Number($("#contestant-number").value);
  const name = $("#contestant-name").value.trim();
  const event = currentEvent();
  const byDivision = (event?.numbering_mode || "unique") === "by_division";
  const division = byDivision ? $("#contestant-division").value.trim() : null;
  if (!number || !name || (byDivision && !division)) { notify(byDivision ? "Please enter the division, contestant number and name." : "Please enter the contestant number and name."); return; }
  const { error } = await supabaseClient.from("contestants").insert({ event_id: currentAdminEventId, number, name, division });
  if (error) { notify(error.message, ERR_TITLE); return; }
  $("#contestant-number").value = "";
  $("#contestant-name").value = "";
  await Promise.all([loadAdminContestants(), loadAdminScores()]);
}

async function loadAdminContestants() {
  const eventId = currentAdminEventId;
  if (!eventId) return;
  const { data, error } = await supabaseClient.from("contestants")
    .select("id, number, name, division").eq("event_id", eventId).order("number").order("name");
  if (eventId !== currentAdminEventId) return;
  if (error) { $("#admin-contestants").innerHTML = `<p>${escapeHtml(error.message)}</p>`; return; }
  if (!data.length) { $("#admin-contestants").innerHTML = "<p class='muted'>No contestants yet.</p>"; return; }
  const locked = isEventActive();
  const byDivision = (currentEvent()?.numbering_mode || "unique") === "by_division";
  const rows = data.map(c => `<tr>
    ${byDivision ? `<td>${escapeHtml(c.division || "")}</td>` : ""}<td>${c.number}</td><td>${escapeHtml(c.name)}</td>
    <td class="actions"><button class="secondary small-btn" data-edit-contestant="${c.id}" ${locked ? "disabled" : ""}>Edit</button>
    <button class="danger-small" data-delete-contestant="${c.id}" ${locked ? "disabled" : ""}>Remove</button></td>
  </tr>`).join("");
  $("#admin-contestants").innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr>${byDivision ? "<th>Division</th>" : ""}<th class="col-no">No.</th><th>Contestant</th><th class="col-actions"></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  $("#admin-contestants").querySelectorAll("[data-edit-contestant]").forEach(btn => btn.addEventListener("click", () => editContestant(btn.dataset.editContestant)));
  $("#admin-contestants").querySelectorAll("[data-delete-contestant]").forEach(btn => btn.addEventListener("click", () => deleteContestant(btn.dataset.deleteContestant)));
}

async function editContestant(id) {
  if (isEventActive()) return;
  const { data, error } = await supabaseClient.from("contestants").select("id, division, number, name").eq("id", id).single();
  if (error) { notify(error.message, ERR_TITLE); return; }
  const byDivision = (currentEvent()?.numbering_mode || "unique") === "by_division";
  const saved = await formDialog({
    title: "Edit contestant",
    fields: [
      ...(byDivision ? [{ name: "division", label: "Division", value: data.division || "", required: true }] : []),
      { name: "number", label: "Contestant number", type: "number", value: data.number, required: true, min: 1, integer: true },
      { name: "name", label: "Name", value: data.name, required: true }
    ],
    submitText: "Save changes",
    onSubmit: async (v) => {
      const { error: updateError } = await supabaseClient.from("contestants")
        .update({ division: byDivision ? v.division : null, number: v.number, name: v.name }).eq("id", id);
      if (updateError) return updateError.message;
    }
  });
  if (!saved) return;
  await Promise.all([loadAdminContestants(), loadAdminScores()]);
  toast("Contestant updated.");
}

async function deleteContestant(id) {
  if (isEventActive()) return;
  const ok = await confirmDialog({
    title: "Remove contestant?",
    message: "This contestant and all of their scores will be removed. This can't be undone.",
    confirmText: "Remove",
    danger: true
  });
  if (!ok) return;
  const { error } = await supabaseClient.from("contestants").delete().eq("id", id);
  if (error) { notify(error.message, ERR_TITLE); return; }
  await Promise.all([loadAdminContestants(), loadAdminScores()]);
  toast("Contestant removed.");
}

/* ------------------------------------------------------------------ */
/* ADMIN CATEGORIES + CRITERIA                                        */
/* ------------------------------------------------------------------ */

async function loadAdminCategories() {
  const eventId = currentAdminEventId;
  if (!eventId) return;

  const [categoriesRes, criteriaRes] = await Promise.all([
    supabaseClient.from("scoring_categories")
      .select("id, name, finalist_weight, counts_for_finalists, sort_order")
      .eq("event_id", eventId).order("sort_order").order("name"),
    supabaseClient.from("criteria")
      .select("id, name, max_score, category_id")
      .eq("event_id", eventId).order("name")
  ]);

  if (eventId !== currentAdminEventId) return;
  if (categoriesRes.error) { $("#admin-categories").innerHTML = `<p>${escapeHtml(categoriesRes.error.message)}</p>`; return; }
  if (criteriaRes.error) { $("#admin-categories").innerHTML = `<p>${escapeHtml(criteriaRes.error.message)}</p>`; return; }

  const categories = categoriesRes.data || [];
  const criteria = criteriaRes.data || [];
  const total = categories.filter(c => c.counts_for_finalists)
    .reduce((sum, c) => sum + Number(c.finalist_weight), 0);
  const weightBox = $("#category-weight-total");
  const hasFinalist = categories.some(c => c.counts_for_finalists);
  weightBox.textContent = `Finalist weights: ${round2(total)}% of 100%`;
  weightBox.className = "weight-summary" + (!hasFinalist ? "" : Math.abs(total - 100) < 0.005 ? " ok" : " warn");

  if (!categories.length) {
    $("#admin-categories").innerHTML = `<div class="empty-state"><strong>No scoring categories yet</strong><span class="muted small">Use "Add category" to start building the scoring sheet.</span></div>`;
    return;
  }

  const locked = isEventActive();
  const cards = categories.map((cat, index) => {
    const catCriteria = criteria.filter(c => c.category_id === cat.id);
    const criterionRows = catCriteria.length ? catCriteria.map(c => `
      <div class="criterion-row">
        <div class="criterion-main">
          <strong>${escapeHtml(c.name)}</strong>
          <span class="muted small">Maximum score: ${Number(c.max_score)}</span>
        </div>
        <div class="criterion-actions">
          <button type="button" class="secondary small-btn" data-edit-criterion="${c.id}" ${locked ? "disabled" : ""}>Edit</button>
          <button type="button" class="danger-small" data-delete-criterion="${c.id}" ${locked ? "disabled" : ""}>Remove</button>
        </div>
      </div>`).join("") : `<div class="empty-criteria"><span>No criteria in this category yet.</span></div>`;

    return `
      <article class="category-card">
        <div class="category-card-head">
          <div class="category-title-wrap">
            <span class="category-number">${index + 1}</span>
            <div>
              <h3>${escapeHtml(cat.name)}</h3>
              <div class="category-meta">
                <span>${catCriteria.length} ${catCriteria.length === 1 ? "criterion" : "criteria"}</span>
                ${cat.counts_for_finalists ? `<span class="category-badge">Finalists · ${round2(cat.finalist_weight)}%</span>` : "<span>Not used for finalists</span>"}
              </div>
            </div>
          </div>
          <div class="category-actions">
            <button type="button" class="secondary small-btn" data-edit-category="${cat.id}" ${locked ? "disabled" : ""}>Edit</button>
            <button type="button" class="danger-small" data-delete-category="${cat.id}" ${locked ? "disabled" : ""}>Remove</button>
          </div>
        </div>
        <div class="category-criteria">
          <div class="criteria-label">Criteria</div>
          ${criterionRows}
        </div>
        <form class="criterion-add-form" data-category-id="${cat.id}" ${locked ? `aria-disabled="true"` : ""}>
          <input type="text" name="criterion-name" placeholder="Add criterion to ${escapeHtml(cat.name)}" required ${locked ? "disabled" : ""}>
          <input type="number" name="criterion-max" placeholder="Max" min="1" step="0.01" value="100" required class="criterion-max-input" ${locked ? "disabled" : ""}>
          <button type="submit" ${locked ? "disabled" : ""}>+ Add criterion</button>
        </form>
      </article>`;
  }).join("");

  $("#admin-categories").innerHTML = `<div class="category-list">${cards}</div>${locked ? `<p class="muted small category-lock-note">Scoring setup is locked while this event is Active.</p>` : ""}`;
}

async function selectedFinalistWeight(exceptId = null) {
  const { data } = await supabaseClient.from("scoring_categories").select("id, finalist_weight, counts_for_finalists").eq("event_id", currentAdminEventId);
  return (data || []).filter(c => c.counts_for_finalists && c.id !== exceptId).reduce((s,c) => s + Number(c.finalist_weight), 0);
}

async function openCategoryDialog(id = null) {
  if (!currentAdminEventId) { notify("Please select an event first."); return; }
  if (isEventActive()) { notify("Categories cannot be changed while the event is Active."); return; }

  let existing = null;
  if (id) {
    const { data, error } = await supabaseClient.from("scoring_categories").select("*").eq("id", id).single();
    if (error) { notify(error.message, ERR_TITLE); return; }
    existing = data;
  }
  const others = await selectedFinalistWeight(id);
  const remaining = Math.max(0, Number((100 - others).toFixed(2)));

  const saved = await formDialog({
    title: id ? "Edit category" : "Add category",
    fields: [
      { name: "name", label: "Category name", value: existing?.name || "", required: true, placeholder: "e.g. Talent" },
      { name: "finalist", type: "checkbox", label: "Count toward the finalist score", value: !!existing?.counts_for_finalists },
      { name: "weight", label: "Finalist weight (%)", type: "number", value: existing?.counts_for_finalists ? existing.finalist_weight : "", min: 0, max: 100, showIf: "finalist", hint: `Other categories use ${round2(others)}%, so up to ${round2(remaining)}% is available.` }
    ],
    submitText: id ? "Save changes" : "Add category",
    onSubmit: async (v) => {
      const weight = v.finalist ? v.weight : 0;
      if (v.finalist) {
        if (!(weight > 0)) return "Enter a weight above 0, or turn off finalist scoring for this category.";
        if (others + weight > 100.0001) return `Finalist weights can't total more than 100%. Only ${round2(remaining)}% is available.`;
      }
      let error;
      if (id) {
        ({ error } = await supabaseClient.from("scoring_categories")
          .update({ name: v.name, counts_for_finalists: !!v.finalist, finalist_weight: weight }).eq("id", id));
      } else {
        const { data: last } = await supabaseClient.from("scoring_categories")
          .select("sort_order").eq("event_id", currentAdminEventId)
          .order("sort_order", { ascending: false }).limit(1);
        const sort_order = (last?.[0]?.sort_order ?? 0) + 1;
        ({ error } = await supabaseClient.from("scoring_categories")
          .insert({ event_id: currentAdminEventId, name: v.name, counts_for_finalists: !!v.finalist, finalist_weight: weight, sort_order }));
      }
      if (error) return error.code === "23505" ? "A category with that name already exists in this event." : error.message;
    }
  });
  if (!saved) return;
  await Promise.all([loadAdminCategories(), loadAdminScores()]);
  toast(id ? "Category updated." : "Category added.");
}

async function deleteCategory(id) {
  if (isEventActive()) return;
  const { count, error: countError } = await supabaseClient.from("criteria").select("id", { count: "exact", head: true }).eq("category_id", id);
  if (countError) { notify(countError.message, ERR_TITLE); return; }
  if (count && count > 0) { notify("Remove or move the criteria in this category before removing the category.", "Category isn't empty"); return; }
  const ok = await confirmDialog({ title: "Remove category?", message: "This scoring category will be removed.", confirmText: "Remove", danger: true });
  if (!ok) return;
  const { error } = await supabaseClient.from("scoring_categories").delete().eq("id", id);
  if (error) { notify(error.message, ERR_TITLE); return; }
  await loadAdminCategories();
  toast("Category removed.");
}

async function createCriterion(e) {
  e.preventDefault();
  if (!currentAdminEventId) { notify("Please select an event first."); return; }
  if (isEventActive()) { notify("Criteria cannot be changed while the event is Active."); return; }
  const form = e.target.closest("form[data-category-id]");
  if (!form) return;
  const category_id = form.dataset.categoryId;
  const name = form.querySelector('[name="criterion-name"]').value.trim();
  const max_score = Number(form.querySelector('[name="criterion-max"]').value);
  if (!category_id || !name || !(max_score > 0)) { notify("Please enter a criterion name and a max score above 0."); return; }
  const { error } = await supabaseClient.from("criteria").insert({ event_id: currentAdminEventId, category_id, name, max_score });
  if (error) { notify(error.message, ERR_TITLE); return; }
  form.reset();
  form.querySelector('[name="criterion-max"]').value = "100";
  await Promise.all([loadAdminCategories(), loadAdminScores()]);
}

async function loadAdminCriteria() {
  return loadAdminCategories();
}

async function editCriterion(id) {
  if (isEventActive()) return;
  const { data, error } = await supabaseClient.from("criteria").select("id,name,max_score,category_id").eq("id", id).single();
  if (error) { notify(error.message, ERR_TITLE); return; }
  const saved = await formDialog({
    title: "Edit criterion",
    fields: [
      { name: "name", label: "Criterion name", value: data.name, required: true },
      { name: "max", label: "Maximum score", type: "number", value: Number(data.max_score), required: true, min: 1 }
    ],
    submitText: "Save changes",
    onSubmit: async (v) => {
      const { error: updateError } = await supabaseClient.from("criteria").update({ name: v.name, max_score: v.max }).eq("id", id);
      if (updateError) return updateError.message;
    }
  });
  if (!saved) return;
  await Promise.all([loadAdminCategories(), loadAdminScores()]);
  toast("Criterion updated.");
}

async function deleteCriterion(id) {
  if (isEventActive()) return;
  const ok = await confirmDialog({
    title: "Remove criterion?",
    message: "This criterion and all scores entered for it will be removed. This can't be undone.",
    confirmText: "Remove",
    danger: true
  });
  if (!ok) return;
  const { error } = await supabaseClient.from("criteria").delete().eq("id", id);
  if (error) { notify(error.message, ERR_TITLE); return; }
  await Promise.all([loadAdminCategories(), loadAdminScores()]);
  toast("Criterion removed.");
}

/* ------------------------------------------------------------------ */
/* RESULTS + WEIGHTED TABULATION                                     */
/* ------------------------------------------------------------------ */

// PostgREST returns at most ~1000 rows per request, so a single query silently
// drops scores once an event has more than that. Fetch in pages instead.
async function fetchAllScores(eventId) {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseClient.from("scores")
      .select("judge_id, contestant_id, criterion_id, score")
      .eq("event_id", eventId).order("id").range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    rows.push(...data);
    if (data.length < PAGE) return { data: rows, error: null };
  }
}

function setLiveStatus(ok, text) {
  const el = $("#live-status");
  if (!el) return;
  el.className = "live-status " + (ok ? "ok" : "bad");
  el.querySelector(".live-text").textContent = text;
}

async function loadAdminScores({ force = false } = {}) {
  const eventId = currentAdminEventId;
  if (!eventId) return;
  // A request that hangs must not block refreshing forever.
  if (scoresLoading && !force && Date.now() - scoresLoadStartedAt < 15000) return;
  scoresLoading = true;
  scoresLoadStartedAt = Date.now();
  const ticket = ++scoresTicket;
  try {
    const [contestantsRes, categoriesRes, criteriaRes, judgesRes, scoresRes, submissionsRes] = await Promise.all([
      supabaseClient.from("contestants").select("id, number, name, division").eq("event_id", eventId).order("division").order("number"),
      supabaseClient.from("scoring_categories").select("id, name, finalist_weight, counts_for_finalists, sort_order").eq("event_id", eventId).order("sort_order").order("name"),
      supabaseClient.from("criteria").select("id, name, max_score, category_id").eq("event_id", eventId).order("category_id").order("name"),
      supabaseClient.from("event_judges").select("judge_id, active, judge:judge_id(display_name)").eq("event_id", eventId),
      fetchAllScores(eventId),
      supabaseClient.from("judge_submissions").select("judge_id, finalized_at").eq("event_id", eventId)
    ]);
    if (eventId !== currentAdminEventId || ticket !== scoresTicket) return;
    const failed = [contestantsRes, categoriesRes, criteriaRes, judgesRes, scoresRes, submissionsRes].find(r => r.error);
    if (failed) {
      setLiveStatus(false, "Can't reach the server — retrying…");
      // Keep showing the last good table; only show the error if nothing is rendered yet.
      if (!$("#admin-scores").querySelector(".result-toolbar")) $("#admin-scores").innerHTML = `<p class="muted">${escapeHtml(failed.error.message)}</p>`;
      return;
    }

    // Include judges who have historical scores even if their event assignment was removed.
    const judgeMap = new Map();
    (judgesRes.data || []).forEach(j => judgeMap.set(j.judge_id, { id:j.judge_id, name:j.judge?.display_name||"Unknown Judge", active:j.active }));
    (scoresRes.data || []).forEach(s => { if (!judgeMap.has(s.judge_id)) judgeMap.set(s.judge_id, { id:s.judge_id, name:"Removed Judge", active:false }); });
    const missingNames = [...judgeMap.values()].filter(j => j.name === "Removed Judge");
    if (missingNames.length) {
      const ids = missingNames.map(j => j.id);
      const { data: profiles } = await supabaseClient.from("profiles").select("id, display_name").in("id", ids);
      (profiles || []).forEach(p => { const j=judgeMap.get(p.id); if(j) j.name=p.display_name; });
    }

    currentResultsCache = {
      event: currentEvent(), contestants: contestantsRes.data || [], categories: categoriesRes.data || [],
      criteria: criteriaRes.data || [], judges: [...judgeMap.values()].sort((a,b)=>a.name.localeCompare(b.name)),
      scores: scoresRes.data || [], submissions: submissionsRes.data || []
    };
    if (ticket !== scoresTicket) return;
    renderResults(currentResultsCache);
    setLiveStatus(true, "Live · updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  } catch (err) {
    console.error("Results refresh failed:", err);
    setLiveStatus(false, "Can't reach the server — retrying…");
  } finally {
    if (ticket === scoresTicket) scoresLoading = false;
  }
}

function renderResults(model) {
  const { contestants, categories, criteria, judges, scores, submissions } = model;
  const box = $("#admin-scores");
  if (!contestants.length || !criteria.length || !judges.length) {
    const missing=[]; if(!contestants.length)missing.push("contestants"); if(!criteria.length)missing.push("criteria"); if(!judges.length)missing.push("judges");
    box.innerHTML=`<div class="empty-state"><strong>Nothing to tabulate yet</strong><span class="muted small">Add ${missing.join(", ")} to start the tabulation.</span></div>`; return;
  }
  const categoryMap = new Map(categories.map(c => [c.id, c]));
  const scoreMap = new Map();
  for (const s of scores) if (s.score !== null) scoreMap.set(`${s.judge_id}:${s.contestant_id}:${s.criterion_id}`, Number(s.score));
  const submissionMap = new Map(submissions.map(s => [s.judge_id, s.finalized_at]));
  const finalistCategories = categories.filter(c => c.counts_for_finalists && Number(c.finalist_weight) > 0);

  const results = contestants.map(c => {
    const perJudge={};
    for (const j of judges) {
      const categoryScores={}; const categoryComplete={};
      for (const cat of categories) {
        const catCriteria=criteria.filter(k=>k.category_id===cat.id);
        const values=catCriteria.map(k=>scoreMap.get(`${j.id}:${c.id}:${k.id}`));
        const completeCat=catCriteria.length>0 && values.every(v=>v!==undefined);
        categoryComplete[cat.id]=completeCat;
        const pct=completeCat ? values.reduce((sum,v,idx)=>sum + (v/Number(catCriteria[idx].max_score))*100,0)/values.length : null;
        categoryScores[cat.id]=pct;
      }
      // The finalist score only needs the categories that actually count toward
      // it. A non-finalist category being unscored, or a finalist category that
      // has no criteria yet, must not block a judge's finished contestants.
      const complete = finalistCategories.every(cat => {
        const catCriteria=criteria.filter(k=>k.category_id===cat.id);
        return catCriteria.length===0 || categoryComplete[cat.id];
      });
      let finalistScore=null;
      if (complete && finalistCategories.length) {
        finalistScore=finalistCategories.reduce((sum,cat)=>sum + (categoryScores[cat.id]||0)*(Number(cat.finalist_weight)/100),0);
      }
      perJudge[j.id]={categoryScores, complete, finalistScore};
    }
    const completeScores=judges.map(j=>perJudge[j.id].finalistScore).filter(v=>v!==null);
    const average=completeScores.length ? completeScores.reduce((a,b)=>a+b,0)/completeScores.length : null;
    return { contestant:c, perJudge, average, judgesDone:completeScores.length };
  });
  const ranked=results.filter(r=>r.average!==null).sort((a,b)=>b.average-a.average || a.contestant.number-b.contestant.number);
  ranked.forEach((r,i)=>{const prev=ranked[i-1];r.rank=prev&&round2(prev.average)===round2(r.average)?prev.rank:i+1;});
  const ordered=[...ranked,...results.filter(r=>r.average===null)];
  const judgeHeaders=judges.map(j=>`<th>${escapeHtml(j.name)}${submissionMap.has(j.id)?" <small class='muted'>(final)</small>":j.active?"":" <small class='muted'>(off)</small>"}</th>`).join("");
  const rankRows=ordered.map(r=>{
    const cells=judges.map(j=>{const p=r.perJudge[j.id]; if(p.finalistScore!==null)return `<td>${p.finalistScore.toFixed(2)}</td>`; return `<td class="muted">${p.complete?"—":"Incomplete"}</td>`;}).join("");
    return `<tr><td class="t-left rank-cell"><strong>${r.rank??"—"}</strong></td>${r.contestant.division ? `<td class="t-left">${escapeHtml(r.contestant.division)}</td>` : ""}<td class="t-left muted-cell">${r.contestant.number}</td><td class="t-left">${escapeHtml(r.contestant.name)}</td>${cells}<td>${r.judgesDone}/${judges.length}</td><td><strong>${r.average===null?"—":r.average.toFixed(2)}</strong></td></tr>`;
  }).join("");
  const weightText=finalistCategories.length ? finalistCategories.map(c=>`${escapeHtml(c.name)} ${round2(c.finalist_weight)}%`).join(" · ") : "No finalist categories configured yet.";
  const showDivision = (currentEvent()?.numbering_mode || "unique") === "by_division";
  const rankingTable=`<div class="table-scroll"><table class="ranking"><thead><tr><th class="t-left">Rank</th>${showDivision ? '<th class="t-left">Division</th>' : ""}<th class="t-left">No.</th><th class="t-left">Contestant</th>${judgeHeaders}<th>Judges done</th><th>Finalist score</th></tr></thead><tbody>${rankRows}</tbody></table></div>`;

  const detail=judges.map(j=>{
    const totalCells=contestants.length*criteria.length;
    const entered=criteria.reduce((n,k)=>n+contestants.filter(c=>scoreMap.has(`${j.id}:${c.id}:${k.id}`)).length,0);
    const judgeOpen=openJudgeTables.has(j.id)?"open":"";
    const categoryBlocks=categories.map(cat=>{
      const catCriteria=criteria.filter(k=>k.category_id===cat.id);
      const catTotal=contestants.length*catCriteria.length;
      const catEntered=contestants.reduce((n,c)=>n+catCriteria.filter(k=>scoreMap.has(`${j.id}:${c.id}:${k.id}`)).length,0);
      const catComplete=catTotal>0 && catEntered===catTotal;
      const categoryKey=`${j.id}:${cat.id}`;
      const categoryOpen=openJudgeCategories.has(categoryKey)?"open":"";
      const rows=contestants.map(c=>{
        const cells=catCriteria.map(k=>{
          const v=scoreMap.get(`${j.id}:${c.id}:${k.id}`);
          return v===undefined?`<td class="muted">—</td>`:`<td>${v}</td>`;
        }).join("");
        const p=results.find(r=>r.contestant.id===c.id)?.perJudge[j.id];
        const pct=p?.categoryScores?.[cat.id];
        const contribution=finalistCategories.includes(cat) && pct!==null && pct!==undefined ? pct*Number(cat.finalist_weight)/100 : null;
        const contributionCell=finalistCategories.includes(cat)?`<td>${contribution===null?"—":contribution.toFixed(2)}</td>`:"";
        const label=c.division?`${escapeHtml(c.division)} ${c.number}. ${escapeHtml(c.name)}`:`${c.number}. ${escapeHtml(c.name)}`;
        return `<tr><td>${label}</td>${cells}${contributionCell}</tr>`;
      }).join("");
      const carryHeader=finalistCategories.includes(cat)?`<th>Finalist contribution<br><small class="muted">${round2(cat.finalist_weight)}%</small></th>`:"";
      return `<details class="judge-category-detail" data-judge-category-key="${escapeHtml(categoryKey)}" ${categoryOpen}><summary><span><strong>${escapeHtml(cat.name)}</strong><small>${catEntered}/${catTotal} scores</small></span><span class="category-detail-status ${catComplete?"complete":"pending"}">${catComplete?"Complete":"In progress"}</span></summary><div class="table-scroll"><table class="detail"><thead><tr><th>Contestant</th>${catCriteria.map(k=>`<th>${escapeHtml(k.name)}<br><small class="muted">max ${Number(k.max_score)}</small></th>`).join("")}${carryHeader}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
    }).join("");
    return `<details class="judge-score-table" data-judge="${j.id}" ${judgeOpen}><summary><span><strong>${escapeHtml(j.name)}</strong><small>${entered}/${totalCells} scores entered${submissionMap.has(j.id)?" · Finalized":j.active?"":" · Off"}</small></span></summary><div class="judge-actions"><button class="secondary small-btn" data-export-judge="${j.id}">Export ${escapeHtml(j.name)} PDF</button></div><div class="judge-category-details">${categoryBlocks}</div></details>`;
  }).join("");
  const html=`<div class="result-toolbar"><div><span class="toolbar-label">Finalist calculation</span><span>${weightText}</span></div><button id="export-overall" class="secondary">Export overall PDF</button></div><h4>Ranking</h4>${rankingTable}<p class="muted small table-note">A contestant is ranked once at least one judge has scored every criterion for them. The average counts only judges who finished that contestant.</p><h4>Score details per judge</h4>${detail}`;
  // Polling runs every 3s: only touch the DOM when something actually changed,
  // so scroll position, text selection and open panels are not disturbed.
  if (box._lastHtml === html && box.querySelector(".result-toolbar")) return;
  box._lastHtml = html;
  box.innerHTML=html;
  $("#export-overall").addEventListener("click", exportOverallPdf);
  box.querySelectorAll("[data-export-judge]").forEach(btn=>btn.addEventListener("click",()=>exportJudgePdf(btn.dataset.exportJudge)));
}

/* ------------------------------------------------------------------ */
/* PDF EXPORT                                                         */
/* ------------------------------------------------------------------ */

function pdfDoc(title) {
  if (!window.jspdf?.jsPDF) { notify("PDF export is not available. Please check the jsPDF libraries in index.html."); return null; }
  const doc=new window.jspdf.jsPDF({orientation:"landscape",unit:"pt",format:"a4"});
  doc.setFontSize(16); doc.text(title,40,40); doc.setFontSize(9); doc.text(new Date().toLocaleString(),40,56); return doc;
}

function ensureAutoTable(doc){
  if(typeof doc.autoTable!=="function"){notify("PDF table export is not available. Please check the jsPDF AutoTable library.");return false;} return true;
}

// Category % for one judge/contestant/category: null if any criterion in that
// category is unscored. catCriteria.length === 0 (category still empty) also
// returns null — shown as "—", never blocks anything else.
function categoryPct(scoreMap, judgeId, contestantId, catCriteria) {
  if (!catCriteria.length) return null;
  const values = catCriteria.map(k => scoreMap.get(`${judgeId}:${contestantId}:${k.id}`));
  if (!values.every(v => v !== undefined)) return null;
  return values.reduce((sum, v, idx) => sum + (v / Number(catCriteria[idx].max_score)) * 100, 0) / values.length;
}

// Places a section title + table right after whatever came before it, only
// starting a new page when there isn't room left for the title and at least
// a header row — so short categories share a page instead of wasting paper.
function addCategorySection(doc, title, tableOpts) {
  const margin = 40;
  const pageHeight = doc.internal.pageSize.getHeight();
  let y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 26 : 70;
  if (y + 40 > pageHeight - margin) {
    doc.addPage();
    y = margin + 20;
  }
  doc.setFontSize(11);
  doc.text(title, margin, y);
  doc.autoTable({ ...tableOpts, startY: y + 10 });
}

function exportOverallPdf(){
  const m=currentResultsCache; if(!m)return;
  const doc=pdfDoc(`${m.event?.name||"Event"} — Overall Results`); if(!doc||!ensureAutoTable(doc))return;
  const scoreMap=new Map(m.scores.map(s=>[`${s.judge_id}:${s.contestant_id}:${s.criterion_id}`,s.score]));
  const finalistCats=m.categories.filter(c=>c.counts_for_finalists&&Number(c.finalist_weight)>0);
  const rows=m.contestants.map(c=>{
    const judgeScores=m.judges.map(j=>{
      const vals=[];
      for(const cat of finalistCats){const ks=m.criteria.filter(k=>k.category_id===cat.id);const ok=ks.every(k=>scoreMap.has(`${j.id}:${c.id}:${k.id}`));if(!ok)return null;const pct=ks.reduce((s,k)=>s+Number(scoreMap.get(`${j.id}:${c.id}:${k.id}`))/Number(k.max_score)*100,0)/ks.length;vals.push(pct*Number(cat.finalist_weight)/100);}
      return vals.length===finalistCats.length?vals.reduce((a,b)=>a+b,0):null;
    });
    const done=judgeScores.filter(v=>v!==null); const avg=done.length?done.reduce((a,b)=>a+b,0)/done.length:null;
    return {c,judgeScores,avg};
  }).filter(r=>r.avg!==null).sort((a,b)=>b.avg-a.avg||a.c.number-b.c.number);
  const showDivision=(m.event?.numbering_mode||"unique")==="by_division";
  doc.autoTable({startY:70,head:[["Rank",...(showDivision?["Division"]:[]),"No.","Contestant",...m.judges.map(j=>j.name),"Finalist score"]],body:rows.map((r,i)=>[i+1,...(showDivision?[r.c.division||""]:[]),r.c.number,r.c.name,...r.judgeScores.map(v=>v===null?"—":v.toFixed(2)),r.avg.toFixed(2)]) ,styles:{fontSize:7},headStyles:{fontSize:7}});

  // One page per category: every judge's % for that category, side by side.
  for (const cat of m.categories) {
    const catCriteria = m.criteria.filter(k => k.category_id === cat.id);
    if (!catCriteria.length) continue; // nothing scored here yet, nothing to show

    const isFinalist = finalistCats.includes(cat);
    const subtitle = isFinalist
      ? `${cat.name} — counts ${round2(cat.finalist_weight)}% toward the finalist score`
      : `${cat.name} — not counted toward the finalist score`;

    addCategorySection(doc, subtitle, {
      head: [[...(showDivision?["Division"]:[]),"No.","Contestant",...m.judges.map(j=>j.name)]],
      body: m.contestants.map(c => [
        ...(showDivision?[c.division||""]:[]), c.number, c.name,
        ...m.judges.map(j => { const pct = categoryPct(scoreMap, j.id, c.id, catCriteria); return pct===null?"—":pct.toFixed(2)+"%"; })
      ]),
      styles:{fontSize:7}, headStyles:{fontSize:7}
    });
  }

  doc.save("overall-results.pdf");
}

function exportJudgePdf(judgeId){
  const m=currentResultsCache; if(!m)return; const judge=m.judges.find(j=>j.id===judgeId); if(!judge)return;
  const doc=pdfDoc(`${m.event?.name||"Event"} — ${judge.name}`); if(!doc||!ensureAutoTable(doc))return;
  const scoreMap=new Map(m.scores.map(s=>[`${s.judge_id}:${s.contestant_id}:${s.criterion_id}`,s.score]));
  const finalistCats=m.categories.filter(c=>c.counts_for_finalists&&Number(c.finalist_weight)>0);
  const showDivision=(m.event?.numbering_mode||"unique")==="by_division";

  // Page 1: overview with this judge's blended finalist score per contestant.
  const rows=m.contestants.map(c=>{
    let fs=null; if(finalistCats.length && finalistCats.every(cat=>{const ks=m.criteria.filter(k=>k.category_id===cat.id);return ks.length&&ks.every(k=>scoreMap.has(`${judge.id}:${c.id}:${k.id}`));})){
      fs=finalistCats.reduce((sum,cat)=>{const ks=m.criteria.filter(k=>k.category_id===cat.id);const pct=ks.reduce((s,k)=>s+Number(scoreMap.get(`${judge.id}:${c.id}:${k.id}`))/Number(k.max_score)*100,0)/ks.length;return sum+pct*Number(cat.finalist_weight)/100;},0);
    }
    return [...(showDivision?[c.division||""]:[]),c.number,c.name,fs===null?"—":fs.toFixed(2)];
  });
  doc.autoTable({startY:70,head:[[...(showDivision?["Division"]:[]),"No.","Contestant","Finalist score"]],body:rows,styles:{fontSize:7},headStyles:{fontSize:7}});

  // One page per category: this judge's raw scores, criterion by criterion.
  for (const cat of m.categories) {
    const catCriteria = m.criteria.filter(k => k.category_id === cat.id);
    if (!catCriteria.length) continue;

    const isFinalist = finalistCats.includes(cat);
    const subtitle = isFinalist
      ? `${cat.name} — counts ${round2(cat.finalist_weight)}% toward the finalist score`
      : `${cat.name} — not counted toward the finalist score`;

    addCategorySection(doc, subtitle, {
      head: [[...(showDivision?["Division"]:[]),"No.","Contestant",...catCriteria.map(k=>`${k.name} (max ${Number(k.max_score)})`),...(isFinalist?["Contribution"]:[])]],
      body: m.contestants.map(c => {
        const vals=catCriteria.map(k=>scoreMap.get(`${judge.id}:${c.id}:${k.id}`));
        const row=[...(showDivision?[c.division||""]:[]), c.number, c.name, ...vals.map(v=>v===undefined?"—":v)];
        if (isFinalist) {
          const pct=categoryPct(scoreMap,judge.id,c.id,catCriteria);
          row.push(pct===null?"—":(pct*Number(cat.finalist_weight)/100).toFixed(2));
        }
        return row;
      }),
      styles:{fontSize:7}, headStyles:{fontSize:7}
    });
  }

  doc.save(`${sanitizeFileName(judge.name)}-results.pdf`);
}

/* ------------------------------------------------------------------ */
/* JUDGE SCORESHEET                                                   */
/* ------------------------------------------------------------------ */

async function loadJudgeScoresheet() {
  const sheet = $("#judge-scoresheet");
  const { data: assignments, error: assignmentError } = await supabaseClient.from("event_judges")
    .select("event_id, events(name,status)").eq("judge_id", currentUser.id).eq("active", true);

  if (assignmentError) { sheet.innerHTML = `<p>${escapeHtml(assignmentError.message)}</p>`; return; }

  const assignment = (assignments || []).find(a => a.events?.status === "active");
  if (!assignment) {
    $("#judge-event-name").textContent = "Judge Scoresheet";
    sheet.innerHTML = `<div class="judge-empty"><strong>There is no active event right now.</strong><span class="muted small">If judging should be open, ask the admin to set your assigned event to Active.</span></div>`;
    return;
  }

  const eventId = assignment.event_id;
  $("#judge-event-name").textContent = assignment.events.name;

  const [contestantsRes, categoriesRes, criteriaRes, scoresRes, submissionRes] = await Promise.all([
    supabaseClient.from("contestants").select("id,name,number,division").eq("event_id", eventId).order("division").order("number"),
    supabaseClient.from("scoring_categories").select("id,name,finalist_weight,counts_for_finalists,sort_order").eq("event_id", eventId).order("sort_order").order("name"),
    supabaseClient.from("criteria").select("id,name,max_score,category_id").eq("event_id", eventId).order("category_id").order("name"),
    supabaseClient.from("scores").select("contestant_id,criterion_id,score").eq("event_id", eventId).eq("judge_id", currentUser.id),
    supabaseClient.from("judge_submissions").select("finalized_at").eq("event_id", eventId).eq("judge_id", currentUser.id).maybeSingle()
  ]);

  if (contestantsRes.error || categoriesRes.error || criteriaRes.error || scoresRes.error || submissionRes.error) {
    sheet.innerHTML = "<p>Could not load the scoresheet.</p>";
    return;
  }

  const contestants = contestantsRes.data || [];
  const categories = categoriesRes.data || [];
  const criteria = criteriaRes.data || [];
  const finalized = !!submissionRes.data;

  if (!contestants.length || !criteria.length || !categories.length) {
    sheet.innerHTML = `<div class="judge-empty"><strong>The scoresheet is not ready yet.</strong><span class="muted small">The admin needs to add contestants, categories, and criteria.</span></div>`;
    return;
  }

  const scoreMap = new Map((scoresRes.data || []).map(s => [`${s.contestant_id}:${s.criterion_id}`, s.score]));
  const totalCells = contestants.length * criteria.length;
  const enteredCells = criteria.reduce((count, k) => count + contestants.filter(c => scoreMap.get(`${c.id}:${k.id}`) !== null && scoreMap.get(`${c.id}:${k.id}`) !== undefined).length, 0);
  const categoryCompletion = categories.map(cat => {
    const ks = criteria.filter(k => k.category_id === cat.id);
    const entered = ks.reduce((n, k) => n + contestants.filter(c => scoreMap.get(`${c.id}:${k.id}`) !== null && scoreMap.get(`${c.id}:${k.id}`) !== undefined).length, 0);
    const total = contestants.length * ks.length;
    return { cat, entered, total, complete: total > 0 && entered === total };
  });

  if (judgeCategoryIndex >= categories.length) judgeCategoryIndex = categories.length - 1;
  if (judgeCategoryIndex < 0) judgeCategoryIndex = 0;
  localStorage.setItem("sc_judge_category_index", String(judgeCategoryIndex));

  const activeCategory = categories[judgeCategoryIndex];
  const activeCriteria = criteria.filter(k => k.category_id === activeCategory.id);
  const activeCompletion = categoryCompletion[judgeCategoryIndex];
  const overallPercent = totalCells ? Math.round((enteredCells / totalCells) * 100) : 0;

  let html = `
    <div class="judge-progress-card">
      <div>
        <div class="progress-title">Overall progress <strong>${overallPercent}%</strong></div>
        <div class="progress-track"><span style="width:${overallPercent}%"></span></div>
        <div class="muted small">${enteredCells} of ${totalCells} scores entered</div>
      </div>
      <div class="judge-finalize-area">
        ${finalized
          ? `<span class="finalized-badge">✓ Scores finalized</span>`
          : `<button id="finalize-scores" ${enteredCells < totalCells ? "disabled" : ""}>Finalize Score</button>`}
      </div>
    </div>

    <div class="category-stepper" role="tablist" aria-label="Scoring categories">
      ${categoryCompletion.map((item, i) => `
        <button type="button" class="category-step ${i === judgeCategoryIndex ? "active" : ""} ${item.complete ? "complete" : ""}" data-judge-category="${i}">
          <span class="step-number">${item.complete ? "✓" : i + 1}</span>
          <span class="step-text"><strong>${escapeHtml(item.cat.name)}</strong><small>${item.entered}/${item.total || 0}</small></span>
        </button>`).join("")}
    </div>

    <section class="judge-category-card">
      <div class="judge-category-head">
        <div>
          <div class="category-kicker">Category ${judgeCategoryIndex + 1} of ${categories.length}</div>
          <h3>${escapeHtml(activeCategory.name)}</h3>
          <p class="muted small">${activeCompletion.entered} of ${activeCompletion.total} scores entered${activeCategory.counts_for_finalists ? ` · ${round2(activeCategory.finalist_weight)}% finalist weight` : ""}</p>
        </div>
        ${activeCompletion.complete ? `<span class="category-complete">✓ Complete</span>` : `<span class="category-pending">In progress</span>`}
      </div>

      ${activeCriteria.length ? `<div class="table-scroll judge-category-table-wrap"><table class="category-scoresheet"><thead><tr><th>Contestant</th>${activeCriteria.map(k => `<th>${escapeHtml(k.name)}<small>Max ${Number(k.max_score)}</small></th>`).join("")}</tr></thead><tbody>
        ${contestants.map(c => {
          const label = c.division ? `${escapeHtml(c.division)} · ${c.number}. ${escapeHtml(c.name)}` : `${c.number}. ${escapeHtml(c.name)}`;
          return `<tr><td class="contestant-cell"><strong>${label}</strong></td>${activeCriteria.map(k => {
            const saved = scoreMap.get(`${c.id}:${k.id}`);
            return `<td data-label="${escapeHtml(k.name)} (max ${Number(k.max_score)})"><input class="score-input" type="number" min="0" max="${Number(k.max_score)}" step="0.01" value="${saved ?? ""}" data-event-id="${eventId}" data-contestant-id="${c.id}" data-criterion-id="${k.id}" data-max="${Number(k.max_score)}" placeholder="0-${Number(k.max_score)}" ${finalized ? "disabled" : ""}></td>`;
          }).join("")}</tr>`;
        }).join("")}
      </tbody></table></div>` : `<div class="empty-criteria"><strong>No criteria in this category.</strong></div>`}
    </section>

    <div class="judge-category-nav">
      <button type="button" class="secondary" id="judge-prev-category" ${judgeCategoryIndex === 0 ? "disabled" : ""}>← Previous</button>
      <span class="muted small">${judgeCategoryIndex + 1} / ${categories.length}</span>
      <button type="button" id="judge-next-category" ${judgeCategoryIndex === categories.length - 1 ? "disabled" : ""}>Next →</button>
    </div>`;

  sheet.innerHTML = html;

  sheet.querySelectorAll(".score-input").forEach(input => {
    input.addEventListener("input", () => clampScoreInput(input));
    input.addEventListener("change", saveScore);
  });

  sheet.querySelectorAll("[data-judge-category]").forEach(btn => btn.addEventListener("click", () => {
    judgeCategoryIndex = Number(btn.dataset.judgeCategory);
    localStorage.setItem("sc_judge_category_index", String(judgeCategoryIndex));
    loadJudgeScoresheet();
  }));

  $("#judge-prev-category")?.addEventListener("click", () => {
    judgeCategoryIndex = Math.max(0, judgeCategoryIndex - 1);
    localStorage.setItem("sc_judge_category_index", String(judgeCategoryIndex));
    loadJudgeScoresheet();
  });

  $("#judge-next-category")?.addEventListener("click", () => {
    judgeCategoryIndex = Math.min(categories.length - 1, judgeCategoryIndex + 1);
    localStorage.setItem("sc_judge_category_index", String(judgeCategoryIndex));
    loadJudgeScoresheet();
  });

  $("#finalize-scores")?.addEventListener("click", () => finalizeScores(eventId));
}

function clampScoreInput(input){
  if(input.value === "") return null;
  let value=Number(input.value); const max=Number(input.dataset.max);
  if(Number.isNaN(value)) value=0;
  if(value<0)value=0; if(value>max)value=max;
  input.value=value; return value;
}

async function saveScore(e){
  const input=e.target; const value=clampScoreInput(input); input.classList.remove("saved","error");
  const { error }=await supabaseClient.from("scores").upsert({event_id:input.dataset.eventId,judge_id:currentUser.id,contestant_id:input.dataset.contestantId,criterion_id:input.dataset.criterionId,score:value,submitted_at:new Date().toISOString()},{onConflict:"event_id,judge_id,contestant_id,criterion_id"});
  if(error){input.classList.add("error");notify(error.code==="42501"?"Scoring for this event is closed. Your last change was not saved.":"Score was not saved: "+error.message);return;}
  input.classList.add("saved");
}

async function finalizeScores(eventId){
  const ok = await confirmDialog({
    title: "Finalize your scores?",
    message: "Once finalized, your scores can no longer be changed.",
    confirmText: "Finalize"
  });
  if (!ok) return;
  const { error }=await supabaseClient.rpc("finalize_judge_scores",{p_event:eventId});
  if(error){notify(error.message, ERR_TITLE);return;}
  await loadJudgeScoresheet();
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                            */
/* ------------------------------------------------------------------ */

function startPolling(){stopPolling();pollingTimer=setInterval(()=>{if(currentProfile?.role==="admin")loadAdminScores();},3000);}
function stopPolling(){if(pollingTimer){clearInterval(pollingTimer);pollingTimer=null;}}
function round2(n){return Number(n).toFixed(2).replace(/\.00$/,'').replace(/(\.\d)0$/,'$1');}
function escapeHtml(value){return String(value??"").replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function sanitizeFileName(value){return String(value||"results").replace(/[^a-z0-9-_]+/gi,"-").replace(/^-+|-+$/g,"")||"results";}


/* ------------------------------------------------------------------ */
/* DIALOGS + TOASTS                                                   */
/* ------------------------------------------------------------------ */

const ERR_TITLE = "Something went wrong";
let dialogChain = Promise.resolve();
const pendingNotices = new Set();

// One dialog at a time; extra requests wait their turn. Resolves with whatever
// value the dialog was closed with (null if dismissed with Esc / backdrop).
function openDialog(build, { dismissOnBackdrop = false } = {}) {
  const run = () => new Promise(resolve => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal";
    let result = null;
    const close = (value) => { result = value; dlg.close(); };
    build(dlg, close);
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    if (dismissOnBackdrop) dlg.addEventListener("mousedown", e => { if (e.target === dlg) dlg.close(); });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
  const next = dialogChain.then(run);
  dialogChain = next.catch(() => {});
  return next;
}

function notify(message, titleOrOpts) {
  const opts = typeof titleOrOpts === "string" ? { title: titleOrOpts } : (titleOrOpts || {});
  const key = String(message);
  if (pendingNotices.has(key)) return Promise.resolve();
  pendingNotices.add(key);
  return openDialog((dlg, close) => {
    dlg.setAttribute("role", "alertdialog");
    dlg.setAttribute("aria-labelledby", "dlg-title");
    dlg.setAttribute("aria-describedby", "dlg-msg");
    dlg.innerHTML = `
      <div class="modal-card">
        <div class="modal-head"><h3 id="dlg-title">${escapeHtml(opts.title || "Notice")}</h3></div>
        <div class="modal-body"><p id="dlg-msg">${escapeHtml(message)}</p></div>
        <div class="modal-foot"><button type="button" data-ok autofocus>OK</button></div>
      </div>`;
    dlg.querySelector("[data-ok]").addEventListener("click", () => close(true));
  }, { dismissOnBackdrop: true }).finally(() => pendingNotices.delete(key));
}

function confirmDialog({ title, message, confirmText = "Confirm", cancelText = "Cancel", danger = false }) {
  return openDialog((dlg, close) => {
    dlg.setAttribute("role", "alertdialog");
    dlg.setAttribute("aria-labelledby", "dlg-title");
    dlg.setAttribute("aria-describedby", "dlg-msg");
    dlg.innerHTML = `
      <div class="modal-card">
        <div class="modal-head"><h3 id="dlg-title">${escapeHtml(title)}</h3></div>
        <div class="modal-body"><p id="dlg-msg">${escapeHtml(message)}</p></div>
        <div class="modal-foot">
          <button type="button" class="secondary" data-no ${danger ? "autofocus" : ""}>${escapeHtml(cancelText)}</button>
          <button type="button" class="${danger ? "danger" : ""}" data-yes ${danger ? "" : "autofocus"}>${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    dlg.querySelector("[data-no]").addEventListener("click", () => close(false));
    dlg.querySelector("[data-yes]").addEventListener("click", () => close(true));
  }, { dismissOnBackdrop: true }).then(v => v === true);
}

// fields: [{ name, label, type: text|number|checkbox, value, required, min, max, integer,
//            placeholder, hint, showIf: "<checkbox field name>" }]
// onSubmit(values) may return an error string (dialog stays open and shows it).
// Resolves true when saved, null when cancelled.
function formDialog({ title, description = "", fields, submitText = "Save", onSubmit }) {
  return openDialog((dlg, close) => {
    dlg.setAttribute("aria-labelledby", "dlg-title");
    const fieldHtml = (f) => {
      if (f.type === "checkbox") {
        return `<label class="check-field" data-field="${f.name}"><input type="checkbox" name="${f.name}" ${f.value ? "checked" : ""}><span>${escapeHtml(f.label)}</span></label>`;
      }
      const attrs = [
        `type="${f.inputType || f.type || "text"}"`, `name="${f.name}"`, `value="${escapeHtml(f.value ?? "")}"`,
        f.placeholder ? `placeholder="${escapeHtml(f.placeholder)}"` : "",
        f.type === "number" ? `step="${f.integer ? 1 : "any"}" inputmode="${f.integer ? "numeric" : "decimal"}"` : "",
        f.min !== undefined ? `min="${f.min}"` : "", f.max !== undefined ? `max="${f.max}"` : "",
        'autocomplete="off"'
      ].join(" ");
      return `<label class="field" data-field="${f.name}">
        <span class="field-label">${escapeHtml(f.label)}</span>
        <input ${attrs}>
        ${f.hint ? `<span class="field-hint">${escapeHtml(f.hint)}</span>` : ""}
        <span class="field-error" role="alert"></span>
      </label>`;
    };
    dlg.innerHTML = `
      <form class="modal-card" novalidate>
        <div class="modal-head">
          <h3 id="dlg-title">${escapeHtml(title)}</h3>
          ${description ? `<p class="muted small">${escapeHtml(description)}</p>` : ""}
        </div>
        <div class="modal-body">
          ${fields.map(fieldHtml).join("")}
          <p class="modal-error" role="alert"></p>
        </div>
        <div class="modal-foot">
          <button type="button" class="secondary" data-cancel>Cancel</button>
          <button type="submit" data-submit>${escapeHtml(submitText)}</button>
        </div>
      </form>`;

    const form = dlg.querySelector("form");
    const errorBox = dlg.querySelector(".modal-error");
    const submitBtn = dlg.querySelector("[data-submit]");
    const wrapper = (name) => form.querySelector(`[data-field="${name}"]`);

    // Show / hide fields that depend on a checkbox
    const syncVisibility = () => {
      for (const f of fields) {
        if (!f.showIf) continue;
        wrapper(f.name).classList.toggle("hidden", !form.elements[f.showIf].checked);
      }
    };
    form.addEventListener("change", syncVisibility);
    syncVisibility();

    dlg.querySelector("[data-cancel]").addEventListener("click", () => close(null));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorBox.textContent = "";
      const values = {};
      let firstBad = null;
      for (const f of fields) {
        const el = form.elements[f.name];
        const wrap = wrapper(f.name);
        wrap.querySelector(".field-error")?.replaceChildren();
        if (f.type === "checkbox") { values[f.name] = el.checked; continue; }
        if (wrap.classList.contains("hidden")) { values[f.name] = null; continue; }
        const raw = f.raw ? el.value : el.value.trim();
        let problem = "";
        if (!raw) {
          if (f.required) problem = "This field is required.";
          values[f.name] = f.type === "number" ? null : "";
        } else if (f.type === "number") {
          const n = Number(raw);
          if (Number.isNaN(n)) problem = "Enter a number.";
          else if (f.integer && !Number.isInteger(n)) problem = "Enter a whole number.";
          else if (f.min !== undefined && n < f.min) problem = `Must be at least ${f.min}.`;
          else if (f.max !== undefined && n > f.max) problem = `Must be at most ${f.max}.`;
          values[f.name] = n;
        } else {
          values[f.name] = raw;
        }
        if (problem) {
          wrap.querySelector(".field-error").textContent = problem;
          el.classList.add("invalid");
          if (!firstBad) firstBad = el;
        } else {
          el.classList.remove("invalid");
        }
      }
      if (firstBad) { firstBad.focus(); return; }

      submitBtn.disabled = true;
      const label = submitBtn.textContent;
      submitBtn.textContent = "Saving…";
      let problem;
      try { problem = await onSubmit(values); }
      catch (err) { problem = err?.message || String(err); }
      submitBtn.disabled = false;
      submitBtn.textContent = label;
      if (problem) { errorBox.textContent = problem; return; }
      close(true);
    });

    // Focus the first visible input
    queueMicrotask(() => form.querySelector(".field:not(.hidden) input, .check-field input")?.focus());
  });
}

function toast(message, tone = "success") {
  const root = $("#toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = `toast ${tone}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => { el.classList.add("leaving"); setTimeout(() => el.remove(), 250); }, 2800);
}

function statusBadge(status) {
  const label = String(status || "").charAt(0).toUpperCase() + String(status || "").slice(1);
  return `<span class="badge badge-${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}
