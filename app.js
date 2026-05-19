import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  collection,
  onSnapshot,
  addDoc,
  serverTimestamp,
  query,
  orderBy,
  where,
  limit
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const days = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const sides = ["Attaque", "Défense"];
const roundResults = ["Gagné", "Perdu"];
// Map pool compétitif Rainbow Six Siege / circuit esport actuel.
const COMPETITIVE_MAPS = [
  "Banque",
  "Frontière",
  "Chalet",
  "Clubhouse",
  "Consulat",
  "Café Dostoyevsky",
  "Repaire",
  "Labo de Nighthaven",
  "Forteresse"
];
const MATCH_TYPES = ["Scrim", "Tournoi"];
const SIM_OPPONENTS = ["Team Alpha", "Team Bravo", "Night Wolves", "Blue Stack", "Phoenix", "Vortex", "Aegis", "Nova Five"];
const SITE_PRESETS = ["Bombe A/B", "CCTV", "Cash", "Kids", "Dortoir", "Garage", "Cuisine", "Archives", "Cafétéria", "Laboratoire", "Sous-sol", "Bar"];


let app, auth, db;
let currentUser = null;
let currentProfile = null;
let registeredUsers = [];
let teams = [];
let currentTeam = null;
let pendingRequests = [];
let players = [];
let matches = [];
let availability = {};
let planning = [];
let activityLog = [];
let dataUnsubscribes = [];
let isRegistering = false;

const config = window.R6_FIREBASE_CONFIG || {};
const firebaseReady = Boolean(config.apiKey && config.projectId && config.appId);

if (!firebaseReady) {
  $("setupWarning").classList.remove("hidden");
} else {
  app = initializeApp(config);
  auth = getAuth(app);
  db = getFirestore(app);
  bindAuth();
}

function bindAuth() {
  $("loginBtn").addEventListener("click", login);
  $("registerBtn").addEventListener("click", register);
  $("showLoginPanelBtn")?.addEventListener("click", () => showAuthPanel("login"));
  $("showRegisterPanelBtn")?.addEventListener("click", () => showAuthPanel("register"));
  $("backFromLoginBtn")?.addEventListener("click", () => showAuthPanel("choice"));
  $("backFromRegisterBtn")?.addEventListener("click", () => showAuthPanel("choice"));
  document.querySelectorAll('input[name="registerMode"]').forEach((el) => el.addEventListener("change", updateRegisterMode));
  $("refreshTeamsBtn")?.addEventListener("click", renderTeamSelect);
  $("logoutBtn").addEventListener("click", () => signOut(auth));
  $("pendingLogoutBtn")?.addEventListener("click", () => signOut(auth));
  $("themeToggleBtn")?.addEventListener("click", toggleTheme);
  initTheme();
  subscribeTeamsPublic();
  updateRegisterMode();
  $("saveAvailabilityBtn").addEventListener("click", saveAvailability);
  $("availabilityTableWrap")?.addEventListener("change", refreshAvailabilityColors);
  $("availabilityTableWrap")?.addEventListener("click", handleAvailabilityStatusClick);
  $("addMatchBtn").addEventListener("click", addMatch);
  $("addRandomMatchBtn")?.addEventListener("click", addRandomMatch);
  $("savePlayerBtn").addEventListener("click", savePlayer);
  $("addPlanningRowBtn")?.addEventListener("click", () => addPlanningRow());
  $("savePlanningBtn")?.addEventListener("click", savePlanning);
  $("clearPlanningBtn")?.addEventListener("click", clearPlanning);
  $("statsPeriodFilter")?.addEventListener("change", renderAllStats);
  populateAdminSelects();
  $("addRoundBtn")?.addEventListener("click", () => addRoundRow());
  $("clearRoundsBtn")?.addEventListener("click", () => { $("roundsWrap").innerHTML = ""; });

  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (isRegistering) return;
    if (!user) {
      clearDataSubscriptions();
      showLogin();
      return;
    }
    await loadProfile(user);
    if (["pending", "rejected"].includes(currentProfile?.role)) {
      showPending();
      return;
    }
    showMain();
    subscribeData();
  });
}


function showAuthPanel(panel) {
  const choice = $("authChoiceView");
  const loginPanel = $("loginPanel");
  const registerPanel = $("registerPanel");
  choice?.classList.toggle("hidden", panel !== "choice");
  loginPanel?.classList.toggle("hidden", panel !== "login");
  registerPanel?.classList.toggle("hidden", panel !== "register");
  if (panel === "register") renderTeamSelect();
  setMsg("loginMsg", "");
}

function subscribeTeamsPublic() {
  if (!db) return;
  onSnapshot(query(collection(db, "teams"), orderBy("name", "asc")), (snap) => {
    teams = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTeamSelect();
  }, (err) => console.warn("Liste équipes non chargée", err));
}

function updateRegisterMode() {
  const mode = document.querySelector('input[name="registerMode"]:checked')?.value || "create";
  $("createTeamBlock")?.classList.toggle("hidden", mode !== "create");
  $("joinTeamBlock")?.classList.toggle("hidden", mode !== "join");
  renderTeamSelect();
}

function renderTeamSelect() {
  const sel = $("teamSelect");
  if (!sel) return;
  if (!teams.length) {
    sel.innerHTML = `<option value="">Aucune équipe créée pour le moment</option>`;
    return;
  }
  sel.innerHTML = teams.map((t) => `<option value="${escapeAttr(t.id)}">${escapeHtml(t.name || "Équipe")}</option>`).join("");
}

async function pseudoExistsInTeam(pseudo, teamId, excludeUid = "") {
  const normalized = String(pseudo || "").trim().toLowerCase();
  if (!normalized || !teamId) return false;
  const snap = await getDocs(query(collection(db, "users"), where("teamId", "==", teamId)));
  return snap.docs.some((d) => {
    const data = d.data() || {};
    const role = data.role || "pending";
    const status = data.status || "pending";
    if (d.id === excludeUid) return false;
    if (role === "rejected" || status === "rejected") return false;
    return String(data.name || "").trim().toLowerCase() === normalized;
  });
}

function requestDocId(teamId, uid) {
  return `${teamId}_${uid}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function login() {
  setMsg("loginMsg", "Connexion...");
  try {
    await signInWithEmailAndPassword(auth, $("emailInput").value.trim(), $("passwordInput").value);
    setMsg("loginMsg", "");
  } catch (err) {
    isRegistering = false;
    setMsg("loginMsg", humanError(err));
  }
}

async function register() {
  const pseudo = $("pseudoInput").value.trim();
  const email = ($("registerEmailInput")?.value || "").trim().toLowerCase();
  const password = $("registerPasswordInput")?.value || "";
  const mode = document.querySelector('input[name="registerMode"]:checked')?.value || "create";
  const teamName = $("teamNameInput")?.value.trim();
  const teamIdToJoin = $("teamSelect")?.value || "";

  if (!pseudo) {
    setMsg("loginMsg", "Entre ton pseudo joueur avant de créer le compte.");
    return;
  }
  if (mode === "create" && !teamName) {
    setMsg("loginMsg", "Entre le nom de ton équipe.");
    return;
  }
  if (mode === "join" && !teamIdToJoin) {
    setMsg("loginMsg", "Choisis l’équipe à rejoindre.");
    return;
  }

  if (mode === "join" && await pseudoExistsInTeam(pseudo, teamIdToJoin)) {
    setMsg("loginMsg", "Ce pseudo est déjà utilisé dans cette équipe. Choisis un autre pseudo.");
    return;
  }

  setMsg("loginMsg", "Création du compte...");
  isRegistering = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName: pseudo });

    if (mode === "create") {
      const teamRef = await addDoc(collection(db, "teams"), {
        name: teamName,
        ownerUid: cred.user.uid,
        ownerName: pseudo,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      const profile = {
        uid: cred.user.uid,
        email: cred.user.email,
        name: pseudo,
        role: "admin",
        teamId: teamRef.id,
        teamName,
        status: "active",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      await setDoc(doc(db, "users", cred.user.uid), profile, { merge: true });
      currentUser = cred.user;
      currentProfile = profile;
      currentTeam = { id: teamRef.id, name: teamName, ownerUid: cred.user.uid, ownerName: pseudo };
      isRegistering = false;
      setMsg("loginMsg", "Compte créé. Tu es admin de ton équipe.");
      showMain();
      subscribeData();
    } else {
      const team = teams.find((t) => t.id === teamIdToJoin);
      const profile = {
        uid: cred.user.uid,
        email: cred.user.email,
        name: pseudo,
        role: "pending",
        teamId: teamIdToJoin,
        teamName: team?.name || "Équipe",
        status: "pending",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      await setDoc(doc(db, "users", cred.user.uid), profile, { merge: true });
      await setDoc(doc(db, "teamRequests", requestDocId(teamIdToJoin, cred.user.uid)), {
        uid: cred.user.uid,
        name: pseudo,
        teamId: teamIdToJoin,
        teamName: team?.name || "Équipe",
        status: "pending",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }, { merge: true });
      currentUser = cred.user;
      currentProfile = profile;
      isRegistering = false;
      setMsg("loginMsg", "Demande envoyée à l’admin de l’équipe.");
      showPending();
    }
  } catch (err) {
    isRegistering = false;
    setMsg("loginMsg", humanError(err));
  }
}

async function loadProfile(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    currentProfile = { uid: user.uid, ...snap.data() };
  } else {
    currentProfile = { uid: user.uid, email: user.email, name: user.displayName || guessName(user.email), role: "pending", status: "pending" };
    await setDoc(ref, { ...currentProfile, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
  }

  // Sécurité : si le compte est marqué en attente mais qu'il est propriétaire de son équipe,
  // on le repasse automatiquement admin. Cela corrige les créations d'équipe interrompues
  // par le chargement automatique Firebase.
  if ((currentProfile.role === "pending" || currentProfile.status === "pending") && currentProfile.teamId) {
    const teamSnap = await getDoc(doc(db, "teams", currentProfile.teamId));
    if (teamSnap.exists() && teamSnap.data().ownerUid === user.uid) {
      currentProfile.role = "admin";
      currentProfile.status = "active";
      currentProfile.teamName = teamSnap.data().name || currentProfile.teamName || "Mon équipe";
      await setDoc(ref, { role: "admin", status: "active", teamName: currentProfile.teamName, updatedAt: serverTimestamp() }, { merge: true });
    }
  }

  // Migration douce pour un ancien compte admin sans équipe.
  if (["admin", "player", "viewer"].includes(currentProfile.role) && !currentProfile.teamId) {
    const teamRef = await addDoc(collection(db, "teams"), {
      name: currentProfile.role === "admin" ? "Mon équipe" : `Équipe de ${currentProfile.name || "joueur"}`,
      ownerUid: user.uid,
      ownerName: currentProfile.name || "Admin",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    currentProfile.teamId = teamRef.id;
    currentProfile.teamName = "Mon équipe";
    currentProfile.status = "active";
    await setDoc(ref, { teamId: teamRef.id, teamName: currentProfile.teamName, status: "active", updatedAt: serverTimestamp() }, { merge: true });
  }
  currentTeam = currentProfile.teamId ? (teams.find((t) => t.id === currentProfile.teamId) || { id: currentProfile.teamId, name: currentProfile.teamName || "Mon équipe" }) : null;
}

function showLogin() {
  currentProfile = null;
  currentTeam = null;
  $("loginView").classList.remove("hidden");
  $("pendingView")?.classList.add("hidden");
  $("mainView").classList.add("hidden");
  $("logoutBtn").classList.add("hidden");
  $("userInfo").textContent = "Non connecté";
  showAuthPanel("choice");
}

function showMain() {
  $("loginView").classList.add("hidden");
  $("pendingView")?.classList.add("hidden");
  $("mainView").classList.remove("hidden");
  $("logoutBtn").classList.remove("hidden");
  $("userInfo").textContent = `${currentProfile.name || "Compte connecté"} — ${roleLabel(currentProfile.role)} — ${currentTeam?.name || currentProfile.teamName || "Équipe"}`;
  $("roleText").textContent = `Ton rôle : ${roleLabel(currentProfile.role)} dans ${currentTeam?.name || currentProfile.teamName || "ton équipe"}.`;
  $("adminTab").classList.toggle("hidden", currentProfile.role !== "admin");
  $("historyTabBtn")?.classList.toggle("hidden", currentProfile.role !== "admin");
}

function showPending() {
  $("loginView").classList.add("hidden");
  $("mainView").classList.add("hidden");
  $("pendingView")?.classList.remove("hidden");
  $("logoutBtn").classList.add("hidden");
  const isRejected = currentProfile?.role === "rejected";
  $("userInfo").textContent = `${currentProfile?.name || "Compte connecté"} — ${roleLabel(currentProfile?.role)}`;
  if ($("pendingText")) {
    $("pendingText").textContent = isRejected
      ? "Ta demande d’accès a été refusée. Contacte un admin si c’est une erreur."
      : `Ta demande pour rejoindre ${currentProfile?.teamName || "cette équipe"} est en attente. L’admin de l’équipe doit accepter ton accès avant que tu puisses utiliser le site.`;
  }
}

function teamCollection(name) {
  return collection(db, "teams", currentProfile.teamId, name);
}

function teamDoc(collectionName, docId) {
  return doc(db, "teams", currentProfile.teamId, collectionName, docId);
}

function clearDataSubscriptions() {
  dataUnsubscribes.forEach((fn) => {
    try { fn(); } catch (_) {}
  });
  dataUnsubscribes = [];
  registeredUsers = [];
  players = [];
  pendingRequests = [];
  matches = [];
  availability = {};
  planning = [];
  activityLog = [];
}

function subscribeData() {
  clearDataSubscriptions();
  if (!currentProfile?.teamId) return;

  const unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
    registeredUsers = snap.docs
      .map((d) => ({ id: d.id, uid: d.id, ...d.data() }))
      .filter((u) => u.teamId === currentProfile.teamId);
    players = registeredUsers
      .filter((u) => ["admin", "player"].includes(u.role || "pending"))
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"));
    renderPlayers();
    renderMatchPlayerInputs();
    renderAvailability();
    renderSummary();
    renderPlanning();
    renderAllStats();
  });
  dataUnsubscribes.push(unsubUsers);

  if (currentProfile.role === "admin") {
    const unsubRequests = onSnapshot(query(collection(db, "teamRequests"), orderBy("createdAt", "desc")), (snap) => {
      const byUid = new Map();
      snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((r) => r.teamId === currentProfile.teamId && (r.status || "pending") === "pending")
        .forEach((r) => {
          if (!r.uid) return;
          const user = registeredUsers.find((u) => u.uid === r.uid);
          const merged = { ...r, name: user?.name || r.name || "Joueur", email: user?.email || r.email || "" };
          if (!byUid.has(r.uid)) byUid.set(r.uid, merged);
        });
      pendingRequests = Array.from(byUid.values());
      renderPlayers();
    });
    dataUnsubscribes.push(unsubRequests);
  }

  const unsubAvailability = onSnapshot(teamDoc("availability", "week"), (snap) => {
    availability = snap.exists() ? (snap.data().values || {}) : {};
    renderAvailability();
    renderSummary();
  });
  dataUnsubscribes.push(unsubAvailability);

  const unsubPlanning = onSnapshot(teamDoc("planning", "week"), (snap) => {
    planning = snap.exists() ? (snap.data().items || []) : [];
    renderPlanning();
  });
  dataUnsubscribes.push(unsubPlanning);

  const unsubMatches = onSnapshot(query(teamCollection("matches"), orderBy("date", "desc")), (snap) => {
    matches = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderMatches();
    renderPlanning();
    renderAllStats();
  });
  dataUnsubscribes.push(unsubMatches);

  if (currentProfile.role === "admin") {
    const unsubLog = onSnapshot(query(teamCollection("activityLog"), orderBy("createdAt", "desc"), limit(80)), (snap) => {
      activityLog = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderActivityLog();
    });
    dataUnsubscribes.push(unsubLog);
  }
}

function switchTab(tab) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  const id = tab === "admin" ? "adminTabPanel" : `${tab}Tab`;
  $(id).classList.add("active");
}


function availabilityStatusClass(status) {
  if (status === "Dispo") return "status-dispo";
  if (status === "À confirmer") return "status-confirm";
  if (status === "Indispo") return "status-indispo";
  return "status-empty";
}

function refreshAvailabilityColors() {
  document.querySelectorAll("#availabilityTableWrap td.availability-cell").forEach((td) => {
    const statusInput = td.querySelector('[data-field="status"]');
    const status = statusInput ? statusInput.value : "";
    td.classList.remove("status-dispo", "status-confirm", "status-indispo", "status-empty");
    td.classList.add(availabilityStatusClass(status));
    if (statusInput?.classList?.contains("availability-select")) {
      statusInput.classList.remove("status-dispo", "status-confirm", "status-indispo", "status-empty");
      statusInput.classList.add(availabilityStatusClass(status));
    }
  });
}

function handleAvailabilityStatusClick(event) {
  // Ancien système de boutons conservé sans effet si absent.
  const btn = event.target.closest(".availability-status-btn");
  if (!btn || btn.disabled) return;
  const cell = btn.closest("td.availability-cell");
  const statusInput = cell?.querySelector('[data-field="status"]');
  if (!cell || !statusInput) return;
  statusInput.value = statusInput.value === btn.dataset.status ? "" : (btn.dataset.status || "");
  refreshAvailabilityColors();
}

function renderAvailability() {
  if (!$("availabilityTableWrap")) return;
  const canEditAll = currentProfile?.role === "admin";
  const canEditOwn = currentProfile?.role === "player";
  const currentEmail = (currentProfile?.email || currentUser?.email || "").toLowerCase();

  let html = `<table><thead><tr><th>Joueur</th>${days.map(d => `<th>${d}</th>`).join("")}</tr></thead><tbody>`;
  for (const player of players) {
    const playerKey = safeKey(player.uid || player.email || player.name || player.id);
    const ownsLine = (player.uid && player.uid === currentUser?.uid) || (currentEmail && (player.email || "").toLowerCase() === currentEmail);
    const editable = canEditAll || (canEditOwn && ownsLine);
    html += `<tr><th class="availability-player"><span>${escapeHtml(player.name || "Joueur")}</span></th>`;
    for (const day of days) {
      const cell = availability?.[playerKey]?.[day] || { status: "", note: "" };
      const statusClass = availabilityStatusClass(cell.status);
      html += `<td class="availability-cell ${statusClass}">
        <select class="availability-select ${statusClass}" data-player="${playerKey}" data-day="${day}" data-field="status" ${editable ? "" : "disabled"} aria-label="Disponibilité ${escapeAttr(player.name || "Joueur")} ${day}">
          <option value="" ${!cell.status ? "selected" : ""}>—</option>
          <option value="Dispo" ${cell.status === "Dispo" ? "selected" : ""}>Dispo</option>
          <option value="À confirmer" ${cell.status === "À confirmer" ? "selected" : ""}>À confirmer</option>
          <option value="Indispo" ${cell.status === "Indispo" ? "selected" : ""}>Indispo</option>
        </select>
        <input class="availability-note" data-player="${playerKey}" data-day="${day}" data-field="note" value="${escapeAttr(cell.note || "")}" placeholder="20h-23h" ${editable ? "" : "disabled"} />
      </td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  $("availabilityTableWrap").innerHTML = html;
  refreshAvailabilityColors();
  $("saveAvailabilityBtn").disabled = !(canEditAll || canEditOwn);
}

async function saveAvailability() {
  const next = structuredClone(availability || {});
  document.querySelectorAll("#availabilityTableWrap [data-player]").forEach((el) => {
    const player = el.dataset.player;
    const day = el.dataset.day;
    const field = el.dataset.field;
    if (!next[player]) next[player] = {};
    if (!next[player][day]) next[player][day] = { status: "", note: "" };
    next[player][day][field] = el.value;
  });
  try {
    await setDoc(teamDoc("availability", "week"), { values: next, updatedAt: serverTimestamp() }, { merge: true });
    await logActivity("availability", "Disponibilités mises à jour");
    setMsg("availabilityMsg", "Disponibilités enregistrées pour tout le monde.");
  } catch (err) {
    setMsg("availabilityMsg", humanError(err));
  }
}

function renderSummary() {
  const counts = {};
  days.forEach((d) => counts[d] = 0);
  for (const player of players) {
    const key = safeKey(player.uid || player.email || player.name || player.id);
    for (const day of days) {
      if (availability?.[key]?.[day]?.status === "Dispo") counts[day] += 1;
    }
  }
  $("availabilitySummary").innerHTML = days.map((d) => {
    const count = counts[d];
    const cls = players.length && count === players.length ? "summary-good" : count > 0 ? "summary-mid" : "summary-empty";
    return `<div class="item availability-summary-card ${cls}"><strong>${d}</strong><span>${count} / ${players.length} dispos</span></div>`;
  }).join("");
}

function renderMatchPlayerInputs() {
  const wrap = $("matchPlayersWrap");
  if (!wrap) return;
  if (!players.length) {
    wrap.innerHTML = `<p class="muted">Aucun joueur inscrit. Les joueurs apparaissent après création de compte.</p>`;
    return;
  }
  wrap.innerHTML = `<table class="stats-input compact-player-stats"><thead><tr><th>Présent</th><th>Joueur</th><th>Kills</th><th>Headshots</th><th>Morts</th><th>Assists</th></tr></thead><tbody>
    ${players.map((p) => {
      const key = safeKey(p.uid);
      return `<tr data-stat-row="${key}" data-uid="${escapeAttr(p.uid)}" data-name="${escapeAttr(p.name || "Joueur")}">
        <td><input class="small-check" type="checkbox" data-stat="present" checked></td>
        <td><strong>${escapeHtml(p.name || "Joueur")}</strong></td>
        <td><input type="number" min="0" value="0" data-stat="kills"></td>
        <td><input type="number" min="0" value="0" data-stat="headshots"></td>
        <td><input type="number" min="0" value="0" data-stat="deaths"></td>
        <td><input type="number" min="0" value="0" data-stat="assists"></td>
      </tr>`;
    }).join("")}
  </tbody></table>
  <p class="muted small-note">Plants et defuses sont calculés automatiquement depuis les rounds saisis en dessous.</p>`;
}

function playerOptions(selected = "") {
  const opts = [`<option value="">-</option>`].concat(players.map((p) => {
    const value = p.uid;
    return `<option value="${escapeAttr(value)}" ${selected === value ? "selected" : ""}>${escapeHtml(p.name || "Joueur")}</option>`;
  }));
  return opts.join("");
}

function addRoundRow(data = {}) {
  const wrap = $("roundsWrap");
  if (!wrap) return;
  const index = wrap.querySelectorAll(".round-card").length + 1;
  const div = document.createElement("div");
  div.className = "round-card";
  div.innerHTML = `
    <div class="round-head">
      <strong>Round ${index}</strong>
      <button type="button" class="danger mini" data-remove-round>Supprimer</button>
    </div>
    <div class="grid three compact">
      <div><label>Numéro</label><input type="number" min="1" value="${escapeAttr(data.number || index)}" data-round="number"></div>
      <div><label>Côté</label><select data-round="side">${sides.map(s => `<option value="${s}" ${data.side === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      <div><label>Résultat</label><select data-round="result">${roundResults.map(r => `<option value="${r}" ${data.result === r ? "selected" : ""}>${r}</option>`).join("")}</select></div>
      <div><label>Premier kill</label><select data-round="firstKillUid">${playerOptions(data.firstKillUid || "")}</select></div>
      <div><label>Première mort</label><select data-round="firstDeathUid">${playerOptions(data.firstDeathUid || "")}</select></div>
      <div><label>Plant</label><select data-round="plantUid">${playerOptions(data.plantUid || "")}</select></div>
      <div><label>Defuse</label><select data-round="defuseUid">${playerOptions(data.defuseUid || "")}</select></div>
      <div><label>Clutch</label><select data-round="clutchUid">${playerOptions(data.clutchUid || "")}</select></div>
      <div><label>Site objectif</label><input type="text" value="${escapeAttr(data.site || "")}" placeholder="CCTV, Kids..." data-round="site"></div>
    </div>
    <label>Notes round</label><input type="text" value="${escapeAttr(data.notes || "")}" placeholder="Erreur, strat, info utile..." data-round="notes">
  `;
  div.querySelector("[data-remove-round]").addEventListener("click", () => div.remove());
  wrap.appendChild(div);
}

function collectPlayerStats() {
  const out = {};
  document.querySelectorAll("#matchPlayersWrap [data-stat-row]").forEach((row) => {
    const present = row.querySelector('[data-stat="present"]').checked;
    if (!present) return;
    const uid = row.dataset.uid;
    out[uid] = {
      uid,
      name: row.dataset.name,
      kills: num(row.querySelector('[data-stat="kills"]').value),
      headshots: Math.min(num(row.querySelector('[data-stat="headshots"]')?.value), num(row.querySelector('[data-stat="kills"]').value)),
      deaths: num(row.querySelector('[data-stat="deaths"]').value),
      assists: num(row.querySelector('[data-stat="assists"]').value),
      // Calculés automatiquement depuis les rounds (plantUid / defuseUid).
      plants: 0,
      defuses: 0,
      entryKills: 0,
      entryDeaths: 0,
      clutches: 0
    };
  });
  return out;
}

function collectRounds() {
  return [...document.querySelectorAll("#roundsWrap .round-card")].map((card) => {
    const get = (field) => card.querySelector(`[data-round="${field}"]`)?.value || "";
    return {
      number: num(get("number")),
      side: get("side"),
      result: get("result"),
      firstKillUid: get("firstKillUid"),
      firstDeathUid: get("firstDeathUid"),
      plantUid: get("plantUid"),
      defuseUid: get("defuseUid"),
      clutchUid: get("clutchUid"),
      site: get("site").trim(),
      notes: get("notes").trim()
    };
  }).filter((r) => r.number || r.firstKillUid || r.firstDeathUid || r.notes);
}

function enrichStatsWithRounds(playerStats, rounds) {
  for (const r of rounds) {
    if (r.firstKillUid && playerStats[r.firstKillUid]) playerStats[r.firstKillUid].entryKills += 1;
    if (r.firstDeathUid && playerStats[r.firstDeathUid]) playerStats[r.firstDeathUid].entryDeaths += 1;
    if (r.plantUid && playerStats[r.plantUid]) playerStats[r.plantUid].plants += 1;
    if (r.defuseUid && playerStats[r.defuseUid]) playerStats[r.defuseUid].defuses += 1;
    if (r.clutchUid && playerStats[r.clutchUid]) playerStats[r.clutchUid].clutches += 1;
  }
  return playerStats;
}


function populateAdminSelects() {
  const mapSelect = $("matchMap");
  if (mapSelect) {
    mapSelect.innerHTML = COMPETITIVE_MAPS.map((m) => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`).join("");
  }
  const modeSelect = $("matchMode");
  if (modeSelect) {
    modeSelect.innerHTML = MATCH_TYPES.map((m) => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`).join("");
  }
}

async function addRandomMatch() {
  if (currentProfile.role !== "admin") return;
  if (!players.length) {
    setMsg("matchMsg", "Impossible de créer une simulation : aucun joueur inscrit.");
    return;
  }

  const selectedPlayers = pickRandomPlayers(players, Math.min(5, players.length));
  const win = Math.random() >= 0.42;
  const loserScore = randInt(0, 7);
  const overtime = loserScore >= 6;
  const teamScore = win ? (overtime ? 8 : 7) : loserScore;
  const enemyScore = win ? loserScore : (overtime ? 8 : 7);
  const result = win ? "Victoire" : "Défaite";
  const roundCount = Math.max(1, Math.min(teamScore + enemyScore, 15));
  const matchMap = pick(COMPETITIVE_MAPS);
  const mode = pick(MATCH_TYPES);

  const playerStats = {};
  for (const p of selectedPlayers) {
    const deaths = randInt(3, Math.max(4, roundCount));
    const kills = Math.max(0, Math.round(randInt(2, Math.max(5, roundCount + 2)) + (win ? 1 : 0)));
    playerStats[p.uid] = {
      uid: p.uid,
      name: p.name || "Joueur",
      kills,
      headshots: randInt(0, kills),
      deaths,
      assists: randInt(0, Math.max(2, Math.floor(roundCount / 2))),
      plants: 0,
      defuses: 0,
      entryKills: 0,
      entryDeaths: 0,
      clutches: 0
    };
  }

  const rounds = [];
  let wonRounds = 0;
  let lostRounds = 0;
  for (let i = 1; i <= roundCount; i++) {
    const mustWin = wonRounds < teamScore && (lostRounds >= enemyScore || Math.random() < (win ? 0.58 : 0.43));
    const won = mustWin && wonRounds < teamScore;
    if (won) wonRounds += 1; else lostRounds += 1;
    const firstKill = pick(selectedPlayers)?.uid || "";
    const firstDeath = pick(selectedPlayers.filter((p) => p.uid !== firstKill))?.uid || pick(selectedPlayers)?.uid || "";
    const plant = Math.random() < 0.18 ? pick(selectedPlayers)?.uid || "" : "";
    const defuse = Math.random() < 0.10 ? pick(selectedPlayers)?.uid || "" : "";
    const clutch = Math.random() < 0.08 ? pick(selectedPlayers)?.uid || "" : "";
    rounds.push({
      number: i,
      side: i <= Math.ceil(roundCount / 2) ? pick(sides) : pick(sides),
      result: won ? "Gagné" : "Perdu",
      firstKillUid: firstKill,
      firstDeathUid: firstDeath,
      plantUid: plant,
      defuseUid: defuse,
      clutchUid: clutch,
      site: pick(SITE_PRESETS),
      notes: "Simulation automatique"
    });
  }

  enrichStatsWithRounds(playerStats, rounds);

  try {
    const matchRef = await addDoc(teamCollection("matches"), {
      date: new Date().toISOString().slice(0, 10),
      opponent: pick(SIM_OPPONENTS),
      map: matchMap,
      mode,
      teamScore,
      enemyScore,
      score: `${teamScore}-${enemyScore}`,
      result,
      vodUrl: "",
      notes: "Match généré avec le bouton simulation.",
      playerStats,
      rounds,
      simulated: true,
      createdAt: serverTimestamp(),
      createdBy: currentUser.uid
    });
    await logActivity("match", `Simulation ajoutée : ${matchMap} — ${result} ${teamScore}-${enemyScore}`, { matchId: matchRef.id });
    setMsg("matchMsg", `Simulation ajoutée : ${matchMap} — ${result} ${teamScore}-${enemyScore}.`);
  } catch (err) {
    setMsg("matchMsg", humanError(err));
  }
}

function pickRandomPlayers(list, maxCount) {
  const copy = [...list].sort(() => Math.random() - 0.5);
  const minCount = Math.min(copy.length, Math.min(5, Math.max(1, maxCount)));
  return copy.slice(0, minCount);
}
function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function addMatch() {
  if (currentProfile.role !== "admin") return;
  const rounds = collectRounds();
  const playerStats = enrichStatsWithRounds(collectPlayerStats(), rounds);
  if (!Object.keys(playerStats).length) {
    setMsg("matchMsg", "Coche au moins un joueur présent.");
    return;
  }
  const teamScore = num($("matchTeamScore").value);
  const enemyScore = num($("matchEnemyScore").value);
  const score = `${teamScore}-${enemyScore}`;
  try {
    const matchRef = await addDoc(teamCollection("matches"), {
      date: $("matchDate").value,
      opponent: $("matchOpponent").value.trim(),
      map: $("matchMap").value.trim(),
      mode: $("matchMode").value.trim(),
      teamScore,
      enemyScore,
      score,
      result: $("matchResult").value,
      vodUrl: $("matchVodUrl")?.value.trim() || "",
      notes: $("matchNotes").value.trim(),
      playerStats,
      rounds,
      createdAt: serverTimestamp(),
      createdBy: currentUser.uid
    });
    await logActivity("match", `Match ajouté : ${$("matchOpponent").value.trim() || "Adversaire"} — ${$("matchMap").value.trim() || "Map"}`, { matchId: matchRef.id });
    ["matchOpponent", "matchTeamScore", "matchEnemyScore", "matchVodUrl", "matchNotes"].forEach((id) => $(id).value = "");
    $("roundsWrap").innerHTML = "";
    renderMatchPlayerInputs();
    setMsg("matchMsg", "Match complet ajouté. Les statistiques sont recalculées automatiquement.");
  } catch (err) {
    setMsg("matchMsg", humanError(err));
  }
}

function renderMatches() {
  $("matchList").innerHTML = matches.length ? matches.map((m) => {
    const statsRows = Object.values(m.playerStats || {}).sort((a, b) => String(a.name).localeCompare(String(b.name), "fr"));
    const rounds = Array.isArray(m.rounds) ? m.rounds : [];
    return `<div class="item match-card">
      <div class="item-head"><strong>${escapeHtml(m.date || "Sans date")} — ${escapeHtml(m.opponent || "Adversaire")}</strong><span>${escapeHtml(m.result || "")} ${escapeHtml(m.score || "")}</span></div>
      <p class="muted">Map : ${escapeHtml(m.map || "-")} ${m.mode ? `— ${escapeHtml(m.mode)}` : ""}</p>
      ${m.vodUrl ? `<p><a class="vod-link" href="${escapeAttr(m.vodUrl)}" target="_blank" rel="noopener">Ouvrir la VOD / vidéo</a></p>` : ""}
      <details>
        <summary>Voir les stats du match</summary>
        <div class="table-wrap"><table><thead><tr><th>Joueur</th><th>K</th><th>HS</th><th>HS%</th><th>D</th><th>A</th><th>K/D</th><th>Entry K</th><th>Entry D</th><th>Plants</th><th>Defuses</th><th>Clutches</th></tr></thead><tbody>
          ${statsRows.map((s) => `<tr><td>${escapeHtml(s.name || "Joueur")}</td><td>${s.kills || 0}</td><td>${s.headshots || 0}</td><td>${hsPercent(s.headshots, s.kills)}</td><td>${s.deaths || 0}</td><td>${s.assists || 0}</td><td>${kd(s.kills, s.deaths)}</td><td>${s.entryKills || 0}</td><td>${s.entryDeaths || 0}</td><td>${s.plants || 0}</td><td>${s.defuses || 0}</td><td>${s.clutches || 0}</td></tr>`).join("")}
        </tbody></table></div>
        ${rounds.length ? `<h4>Rounds</h4><div class="table-wrap"><table><thead><tr><th>#</th><th>Côté</th><th>Résultat</th><th>Premier kill</th><th>Première mort</th><th>Plant</th><th>Defuse</th><th>Clutch</th><th>Site / notes</th></tr></thead><tbody>
          ${rounds.map((r) => `<tr><td>${r.number || ""}</td><td>${escapeHtml(r.side || "")}</td><td>${escapeHtml(r.result || "")}</td><td>${escapeHtml(nameByUid(r.firstKillUid))}</td><td>${escapeHtml(nameByUid(r.firstDeathUid))}</td><td>${escapeHtml(nameByUid(r.plantUid))}</td><td>${escapeHtml(nameByUid(r.defuseUid))}</td><td>${escapeHtml(nameByUid(r.clutchUid))}</td><td>${escapeHtml([r.site, r.notes].filter(Boolean).join(" — "))}</td></tr>`).join("")}
        </tbody></table></div>` : `<p class="muted">Aucun round détaillé saisi.</p>`}
      </details>
      ${m.notes ? `<p>${escapeHtml(m.notes)}</p>` : ""}
      ${currentProfile?.role === "admin" ? `<button class="danger" onclick="window.deleteMatch('${m.id}')">Supprimer</button>` : ""}
    </div>`;
  }).join("") : `<p class="muted">Aucun match pour le moment.</p>`;
}

function filteredMatches() {
  const filter = $("statsPeriodFilter")?.value || "all";
  if (filter === "all") return matches;
  const daysBack = Number(filter);
  const limit = new Date();
  limit.setHours(0, 0, 0, 0);
  limit.setDate(limit.getDate() - daysBack);
  return matches.filter((m) => {
    if (!m.date) return false;
    const d = new Date(`${m.date}T00:00:00`);
    return Number.isFinite(d.getTime()) && d >= limit;
  });
}

function renderAllStats() {
  renderStatsTable();
  renderCharts();
  renderMapStats();
  renderRanking();
}

function calculateAggregates() {
  const sourceMatches = filteredMatches();
  const agg = {};
  for (const p of players) {
    agg[p.uid] = { uid: p.uid, name: p.name || "Joueur", matches: 0, wins: 0, kills: 0, headshots: 0, deaths: 0, assists: 0, plants: 0, defuses: 0, entryKills: 0, entryDeaths: 0, clutches: 0 };
  }
  for (const m of sourceMatches) {
    for (const [uid, s] of Object.entries(m.playerStats || {})) {
      if (!agg[uid]) agg[uid] = { uid, name: s.name || nameByUid(uid), matches: 0, wins: 0, kills: 0, headshots: 0, deaths: 0, assists: 0, plants: 0, defuses: 0, entryKills: 0, entryDeaths: 0, clutches: 0 };
      agg[uid].matches += 1;
      if (m.result === "Victoire") agg[uid].wins += 1;
      ["kills", "headshots", "deaths", "assists", "plants", "defuses", "entryKills", "entryDeaths", "clutches"].forEach((k) => agg[uid][k] += num(s[k]));
    }
  }
  return Object.values(agg).sort((a, b) => b.kills - a.kills || String(a.name).localeCompare(String(b.name), "fr"));
}

function renderStatsTable() {
  const wrap = $("statsTableWrap");
  if (!wrap) return;
  const rows = calculateAggregates();
  if (!rows.length) {
    wrap.innerHTML = `<p class="muted">Aucun joueur à afficher.</p>`;
    return;
  }
  wrap.innerHTML = `<table><thead><tr><th>Joueur</th><th>MJ</th><th>Win</th><th>K</th><th>HS</th><th>HS%</th><th>D</th><th>A</th><th>K/D</th><th>KPR</th><th>Entry K</th><th>Entry D</th><th>Plants</th><th>Defuses</th><th>Clutches</th></tr></thead><tbody>
    ${rows.map((r) => {
      const winRate = r.matches ? Math.round((r.wins / r.matches) * 100) : 0;
      const kpr = r.matches ? (r.kills / r.matches).toFixed(1) : "0.0";
      return `<tr><td><strong>${escapeHtml(r.name)}</strong></td><td>${r.matches}</td><td>${winRate}%</td><td>${r.kills}</td><td>${r.headshots}</td><td>${hsPercent(r.headshots, r.kills)}</td><td>${r.deaths}</td><td>${r.assists}</td><td>${kd(r.kills, r.deaths)}</td><td>${kpr}</td><td>${r.entryKills}</td><td>${r.entryDeaths}</td><td>${r.plants}</td><td>${r.defuses}</td><td>${r.clutches}</td></tr>`;
    }).join("")}
  </tbody></table>`;
}

function renderCharts() {
  const rows = calculateAggregates().filter((r) => r.matches > 0 || r.kills > 0 || r.deaths > 0 || r.assists > 0);
  renderRadarCharts(rows);
  renderBarChart("kdChart", rows.map((r) => ({ label: r.name, value: Number(kd(r.kills, r.deaths)) })), "x");
  renderBarChart("killsChart", rows.map((r) => ({ label: r.name, value: r.kills })), "K");
  renderBarChart("hsChart", rows.map((r) => ({ label: r.name, value: Number(hsPercentValue(r.headshots, r.kills)) })), "%");
  renderBarChart("entryChart", rows.map((r) => ({ label: r.name, value: r.entryKills - r.entryDeaths })), "diff");
  renderBarChart("winChart", rows.map((r) => ({ label: r.name, value: r.matches ? Math.round((r.wins / r.matches) * 100) : 0 })), "%");
}

function renderRadarCharts(rows) {
  const el = $("radarCharts");
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = `<p class="chart-empty">Aucune donnée pour le moment.</p>`;
    return;
  }

  const prepared = rows.map((r) => {
    const kdValue = Number(kd(r.kills, r.deaths));
    const kpr = r.matches ? r.kills / r.matches : 0;
    const winRate = r.matches ? (r.wins / r.matches) * 100 : 0;
    const entryDiff = r.matches ? (r.entryKills - r.entryDeaths) / r.matches : 0;
    const objective = r.matches ? (r.plants + r.defuses) / r.matches : 0;
    const clutch = r.matches ? r.clutches / r.matches : 0;
    const hsRate = hsPercentValue(r.headshots, r.kills);
    return { ...r, kdValue, kpr, winRate, entryDiff, objective, clutch, hsRate };
  });

  const maxKpr = Math.max(1, ...prepared.map((r) => r.kpr));
  const maxObjective = Math.max(1, ...prepared.map((r) => r.objective));
  const maxClutch = Math.max(1, ...prepared.map((r) => r.clutch));

  el.innerHTML = prepared.map((r) => {
    const metrics = [
      { label: "K/D", value: clamp01(r.kdValue / 2) },
      { label: "KPR", value: clamp01(r.kpr / maxKpr) },
      { label: "HS%", value: clamp01(r.hsRate / 100) },
      { label: "Win", value: clamp01(r.winRate / 100) },
      { label: "Entry", value: clamp01((r.entryDiff + 1) / 2) },
      { label: "Objectif", value: clamp01(r.objective / maxObjective) },
      { label: "Clutch", value: clamp01(r.clutch / maxClutch) }
    ];
    return `<div class="radar-card">
      <h3>${escapeHtml(r.name)}</h3>
      ${radarSvg(metrics)}
      <div class="radar-mini-stats">
        <span>K/D <strong>${escapeHtml(r.kdValue.toFixed(2))}</strong></span>
        <span>Win <strong>${Math.round(r.winRate)}%</strong></span>
        <span>Entry <strong>${r.entryKills - r.entryDeaths}</strong></span>
        <span>HS <strong>${Math.round(r.hsRate)}%</strong></span>
      </div>
    </div>`;
  }).join("");
}

function radarSvg(metrics) {
  const size = 280;
  const center = size / 2;
  const radius = 92;
  const levels = [0.25, 0.5, 0.75, 1];
  const points = metrics.map((m, i) => radarPoint(center, radius * m.value, i, metrics.length));
  const polygon = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const levelPolygons = levels.map((lvl) => {
    const pts = metrics.map((_, i) => radarPoint(center, radius * lvl, i, metrics.length)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    return `<polygon points="${pts}" class="radar-grid-line"></polygon>`;
  }).join("");
  const axes = metrics.map((m, i) => {
    const end = radarPoint(center, radius, i, metrics.length);
    const label = radarPoint(center, radius + 24, i, metrics.length);
    return `<line x1="${center}" y1="${center}" x2="${end.x.toFixed(1)}" y2="${end.y.toFixed(1)}" class="radar-axis"></line>
      <text x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" class="radar-label">${escapeHtml(m.label)}</text>`;
  }).join("");
  return `<svg class="radar-svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Graphique radar">
    ${levelPolygons}
    ${axes}
    <polygon points="${polygon}" class="radar-area"></polygon>
    ${points.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" class="radar-dot"></circle>`).join("")}
  </svg>`;
}

function radarPoint(center, radius, index, total) {
  const angle = (-Math.PI / 2) + (index * 2 * Math.PI / total);
  return { x: center + Math.cos(angle) * radius, y: center + Math.sin(angle) * radius };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function renderBarChart(id, data, suffix = "") {
  const el = $(id);
  if (!el) return;
  const cleaned = data
    .filter((d) => Number.isFinite(Number(d.value)))
    .sort((a, b) => Number(b.value) - Number(a.value));
  if (!cleaned.length) {
    el.innerHTML = `<p class="chart-empty">Aucune donnée pour le moment.</p>`;
    return;
  }
  const max = Math.max(1, ...cleaned.map((d) => Math.abs(Number(d.value))));
  el.innerHTML = cleaned.map((d) => {
    const value = Number(d.value);
    const width = Math.max(4, Math.round((Math.abs(value) / max) * 100));
    const display = suffix === "x" ? value.toFixed(2) : `${value}${suffix}`;
    return `<div class="chart-row"><div class="chart-label">${escapeHtml(d.label)}</div><div class="chart-track"><div class="chart-fill" style="width:${width}%"></div></div><div class="chart-value">${escapeHtml(display)}</div></div>`;
  }).join("");
}

function renderMapStats() {
  const wrap = $("mapStatsWrap");
  if (!wrap) return;
  const maps = {};
  for (const m of filteredMatches()) {
    const mapName = (m.map || "Map non renseignée").trim() || "Map non renseignée";
    if (!maps[mapName]) {
      maps[mapName] = {
        map: mapName,
        matches: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        roundsWon: 0,
        roundsLost: 0,
        attackWon: 0,
        attackPlayed: 0,
        defenseWon: 0,
        defensePlayed: 0,
        plants: 0,
        defuses: 0,
        clutches: 0,
        entryKills: 0,
        entryDeaths: 0,
        playerKills: {}
      };
    }
    const row = maps[mapName];
    row.matches += 1;
    if (m.result === "Victoire") row.wins += 1;
    else if (m.result === "Défaite") row.losses += 1;
    else row.draws += 1;
    row.roundsWon += num(m.teamScore);
    row.roundsLost += num(m.enemyScore);

    for (const s of Object.values(m.playerStats || {})) {
      row.plants += num(s.plants);
      row.defuses += num(s.defuses);
      row.clutches += num(s.clutches);
      row.entryKills += num(s.entryKills);
      row.entryDeaths += num(s.entryDeaths);
      const name = s.name || nameByUid(s.uid) || "Joueur";
      row.playerKills[name] = (row.playerKills[name] || 0) + num(s.kills);
    }

    for (const r of Array.isArray(m.rounds) ? m.rounds : []) {
      if (r.side === "Attaque") {
        row.attackPlayed += 1;
        if (r.result === "Gagné") row.attackWon += 1;
      }
      if (r.side === "Défense") {
        row.defensePlayed += 1;
        if (r.result === "Gagné") row.defenseWon += 1;
      }
    }
  }
  const rows = Object.values(maps).sort((a, b) => b.matches - a.matches || a.map.localeCompare(b.map, "fr"));
  if (!rows.length) {
    wrap.innerHTML = `<p class="muted">Aucune map à afficher.</p>`;
    return;
  }
  wrap.innerHTML = `<table class="map-stats-table advanced-map-table"><thead><tr><th>Map</th><th>Matchs</th><th>Win %</th><th>V-D-N</th><th>Rounds</th><th>Diff</th><th>Atk %</th><th>Def %</th><th>Plants</th><th>Defuses</th><th>Clutches</th><th>Entry diff</th><th>Top kill</th></tr></thead><tbody>
    ${rows.map((r) => {
      const winRate = r.matches ? Math.round((r.wins / r.matches) * 100) : 0;
      const roundDiff = r.roundsWon - r.roundsLost;
      const attackRate = r.attackPlayed ? `${Math.round((r.attackWon / r.attackPlayed) * 100)}%` : "-";
      const defenseRate = r.defensePlayed ? `${Math.round((r.defenseWon / r.defensePlayed) * 100)}%` : "-";
      const entryDiff = r.entryKills - r.entryDeaths;
      const top = Object.entries(r.playerKills).sort((a, b) => b[1] - a[1])[0];
      return `<tr><td class="map-name"><strong>${escapeHtml(r.map)}</strong></td><td>${r.matches}</td><td>${winRate}%</td><td>${r.wins}-${r.losses}-${r.draws}</td><td>${r.roundsWon}-${r.roundsLost}</td><td class="${roundDiff >= 0 ? "positive" : "negative"}">${roundDiff > 0 ? "+" : ""}${roundDiff}</td><td>${attackRate}</td><td>${defenseRate}</td><td>${r.plants}</td><td>${r.defuses}</td><td>${r.clutches}</td><td class="${entryDiff >= 0 ? "positive" : "negative"}">${entryDiff > 0 ? "+" : ""}${entryDiff}</td><td>${top ? `${escapeHtml(top[0])} (${top[1]})` : "-"}</td></tr>`;
    }).join("")}
  </tbody></table>`;
}


function renderPlanning() {
  const wrap = $("planningWrap");
  if (!wrap) return;
  const isAdmin = currentProfile?.role === "admin";
  $("planningAdminActions")?.classList.toggle("hidden", !isAdmin);
  if (isAdmin) {
    if (!planning.length) {
      wrap.innerHTML = `<p class="muted">Aucune ligne de planning. Clique sur “+ Ajouter une ligne”.</p>`;
      return;
    }
    wrap.innerHTML = `<div class="planning-admin-list">${planning.map((item, i) => planningRowHtml(item, i)).join("")}</div>`;
    wrap.querySelectorAll("[data-remove-planning]").forEach((btn) => btn.addEventListener("click", () => {
      btn.closest(".planning-row")?.remove();
    }));
    return;
  }
  if (!planning.length) {
    wrap.innerHTML = `<p class="muted">Aucun planning publié pour cette semaine.</p>`;
    return;
  }
  const byDay = Object.fromEntries(days.map((d) => [d, []]));
  for (const item of planning) {
    const day = days.includes(item.day) ? item.day : days[0];
    byDay[day].push(item);
  }
  wrap.innerHTML = `<div class="planning-week">${days.map((day) => `<div class="planning-day"><h3>${day}</h3>${byDay[day].length ? byDay[day].map(planningCardHtml).join("") : `<p class="muted small">Rien de prévu</p>`}</div>`).join("")}</div>`;
}

function planningRowHtml(item = {}, index = 0) {
  return `<div class="planning-row" data-planning-row>
    <div><label>Jour</label><select data-plan="day">${days.map((d) => `<option value="${d}" ${item.day === d ? "selected" : ""}>${d}</option>`).join("")}</select></div>
    <div><label>Heure</label><input data-plan="time" type="time" value="${escapeAttr(item.time || "20:30")}"></div>
    <div><label>Type</label><select data-plan="type"><option value="Scrim" ${item.type === "Scrim" ? "selected" : ""}>Scrim</option><option value="Tournoi" ${item.type === "Tournoi" ? "selected" : ""}>Tournoi</option><option value="VOD" ${item.type === "VOD" ? "selected" : ""}>VOD</option><option value="Entraînement" ${item.type === "Entraînement" ? "selected" : ""}>Entraînement</option></select></div>
    <div><label>Titre / adversaire</label><input data-plan="title" value="${escapeAttr(item.title || "")}" placeholder="Ex: Scrim vs Team Alpha"></div>
    <div><label>Map</label><select data-plan="map"><option value="">-</option>${COMPETITIVE_MAPS.map((m) => `<option value="${escapeAttr(m)}" ${item.map === m ? "selected" : ""}>${escapeHtml(m)}</option>`).join("")}</select></div>
    <div><label>Notes</label><input data-plan="notes" value="${escapeAttr(item.notes || "")}" placeholder="RDV vocal, strats..."></div>
    <button type="button" class="danger mini" data-remove-planning>Supprimer</button>
  </div>`;
}

function planningCardHtml(item) {
  return `<div class="planning-event"><strong>${escapeHtml(item.time || "--:--")} — ${escapeHtml(item.type || "Planning")}</strong><br><span>${escapeHtml(item.title || "Sans titre")}</span>${item.map ? `<br><span class="muted">Map : ${escapeHtml(item.map)}</span>` : ""}${item.notes ? `<br><span class="muted">${escapeHtml(item.notes)}</span>` : ""}</div>`;
}

function addPlanningRow(item = {}) {
  planning = readPlanningFromDom();
  planning.push({ day: item.day || days[0], time: item.time || "20:30", type: item.type || "Scrim", title: item.title || "", map: item.map || "", notes: item.notes || "" });
  renderPlanning();
}

function readPlanningFromDom() {
  const rows = [...document.querySelectorAll("#planningWrap [data-planning-row]")];
  if (!rows.length) return planning || [];
  return rows.map((row) => {
    const get = (field) => row.querySelector(`[data-plan="${field}"]`)?.value || "";
    return { day: get("day"), time: get("time"), type: get("type"), title: get("title").trim(), map: get("map"), notes: get("notes").trim() };
  }).filter((item) => item.title || item.notes || item.map || item.time);
}

async function savePlanning() {
  if (currentProfile?.role !== "admin") return;
  try {
    const items = readPlanningFromDom().sort((a, b) => days.indexOf(a.day) - days.indexOf(b.day) || String(a.time).localeCompare(String(b.time)));
    await setDoc(teamDoc("planning", "week"), { items, updatedAt: serverTimestamp(), updatedBy: currentUser.uid }, { merge: true });
    await logActivity("planning", `Planning mis à jour (${items.length} ligne${items.length > 1 ? "s" : ""})`);
    setMsg("planningMsg", "Planning enregistré. Les joueurs le voient directement.");
  } catch (err) {
    setMsg("planningMsg", humanError(err));
  }
}

async function clearPlanning() {
  if (currentProfile?.role !== "admin") return;
  if (!confirm("Vider le planning de la semaine ?")) return;
  try {
    await setDoc(teamDoc("planning", "week"), { items: [], updatedAt: serverTimestamp(), updatedBy: currentUser.uid }, { merge: true });
    await logActivity("planning", "Planning vidé");
    setMsg("planningMsg", "Planning vidé.");
  } catch (err) {
    setMsg("planningMsg", humanError(err));
  }
}

function renderRanking() {
  const wrap = $("rankingWrap");
  if (!wrap) return;
  const rows = calculateAggregates().filter((r) => r.matches > 0);
  if (!rows.length) {
    wrap.innerHTML = `<p class="muted">Aucun classement pour le moment.</p>`;
    return;
  }
  const best = (label, scorer, formatter = (v) => v) => {
    const sorted = [...rows].sort((a, b) => scorer(b) - scorer(a));
    const top = sorted[0];
    return `<div class="ranking-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(top.name)}</strong><em>${escapeHtml(formatter(scorer(top)))}</em></div>`;
  };
  wrap.innerHTML = [
    best("Meilleur K/D", (r) => Number(kd(r.kills, r.deaths)), (v) => v.toFixed(2)),
    best("Plus de kills", (r) => r.kills, (v) => `${v} K`),
    best("Meilleur HS%", (r) => hsPercentValue(r.headshots, r.kills), (v) => `${Math.round(v)}%`),
    best("Meilleur win rate", (r) => r.matches ? Math.round((r.wins / r.matches) * 100) : 0, (v) => `${v}%`),
    best("Meilleur entry", (r) => r.entryKills - r.entryDeaths, (v) => `${v > 0 ? "+" : ""}${v}`),
    best("Objectif", (r) => r.plants + r.defuses, (v) => `${v} actions`),
    best("Clutch", (r) => r.clutches, (v) => `${v} clutch`)
  ].join("");
}

window.deleteMatch = async (id) => {
  if (currentProfile?.role !== "admin") return;
  if (!confirm("Supprimer ce match ?")) return;
  await deleteDoc(doc(db, "teams", currentProfile.teamId, "matches", id));
  await logActivity("match", "Match supprimé", { matchId: id });
};

async function savePlayer() {
  if (currentProfile.role !== "admin") return;
  const name = $("newPlayerName").value.trim();
  const email = $("newPlayerEmail").value.trim().toLowerCase();
  const role = $("newPlayerRole").value;
  if (!name || !email) {
    setMsg("playerMsg", "Nom et email obligatoires.");
    return;
  }

  const account = registeredUsers.find((u) => (u.email || "").toLowerCase() === email);
  if (!account) {
    setMsg("playerMsg", "Ce compte n'existe pas encore. La personne doit d'abord créer son compte sur le site.");
    return;
  }

  try {
    await setDoc(doc(db, "users", account.uid || account.id), { name, role, updatedAt: serverTimestamp() }, { merge: true });
    await logActivity("user", `Compte mis à jour : ${name} (${roleLabel(role)})`, { targetUid: account.uid || account.id });
    setMsg("playerMsg", "Compte mis à jour.");
    ["newPlayerName", "newPlayerEmail"].forEach((id) => $(id).value = "");
  } catch (err) {
    setMsg("playerMsg", humanError(err));
  }
}

function renderPlayers() {
  const playerHtml = players.map((p) => accountCard(p)).join("");
  const accessRequestsHtml = pendingRequests
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"))
    .map((p) => accessRequestCard(p))
    .join("");
  const allAccountsHtml = registeredUsers
    .filter((u) => (u.role || "pending") !== "pending")
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"))
    .map((p) => accountCard(p))
    .join("");
  $("playerList").innerHTML = playerHtml || `<p class="muted">Aucun joueur inscrit pour le moment.</p>`;
  if ($("accessRequestsList")) $("accessRequestsList").innerHTML = accessRequestsHtml || `<p class="muted">Aucune demande en attente pour cette équipe.</p>`;
  $("adminPlayerList").innerHTML = allAccountsHtml || `<p class="muted">Aucun compte accepté pour le moment.</p>`;
}

function accountCard(p) {
  return `<div class="item"><strong>${escapeHtml(p.name || "Joueur")}</strong><br><span class="badge ${p.role || "pending"}">${roleLabel(p.role || "pending")}</span></div>`;
}

function accessRequestCard(p) {
  const uid = escapeHtml(p.uid || "");
  return `<div class="item access-request">
    <strong>${escapeHtml(p.name || "Joueur")}</strong><br>
    <span class="badge pending">${roleLabel("pending")}</span>
    <div class="row access-actions">
      <button type="button" onclick="window.approveAccess('${uid}', 'player')">Accepter joueur</button>
      <button type="button" class="secondary" onclick="window.approveAccess('${uid}', 'viewer')">Accepter lecture seule</button>
      <button type="button" class="danger" onclick="window.rejectAccess('${uid}')">Refuser</button>
    </div>
  </div>`;
}

window.approveAccess = async (uid, role) => {
  if (currentProfile?.role !== "admin" || !uid) return;
  const req = pendingRequests.find((u) => u.uid === uid);
  const userRef = doc(db, "users", uid);
  const userSnap = await getDoc(userRef);
  const existingUser = userSnap.exists() ? userSnap.data() : {};
  const finalName = existingUser.name || req?.name || "Joueur";

  const duplicateName = registeredUsers.some((u) => {
    if (u.uid === uid) return false;
    if (!["admin", "player", "viewer"].includes(u.role || "")) return false;
    return String(u.name || "").trim().toLowerCase() === String(finalName).trim().toLowerCase();
  });
  if (duplicateName) {
    alert(`Le pseudo "${finalName}" est déjà utilisé dans cette équipe. Demande au joueur de recréer son compte avec un autre pseudo, ou modifie un des pseudos avant d’accepter.`);
    return;
  }

  await setDoc(userRef, {
    name: finalName,
    role,
    status: "active",
    teamId: currentProfile.teamId,
    teamName: currentTeam?.name || currentProfile.teamName || "Équipe",
    updatedAt: serverTimestamp()
  }, { merge: true });
  if (req?.id) await setDoc(doc(db, "teamRequests", req.id), { status: "accepted", handledBy: currentUser.uid, handledAt: serverTimestamp() }, { merge: true });
  await logActivity("user", `Demande acceptée : ${finalName} (${roleLabel(role)})`, { targetUid: uid });
};

window.rejectAccess = async (uid) => {
  if (currentProfile?.role !== "admin" || !uid) return;
  const req = pendingRequests.find((u) => u.uid === uid);
  if (!confirm(`Refuser la demande de ${req?.name || "ce compte"} ?`)) return;
  await setDoc(doc(db, "users", uid), { role: "rejected", status: "rejected", updatedAt: serverTimestamp() }, { merge: true });
  if (req?.id) await setDoc(doc(db, "teamRequests", req.id), { status: "rejected", handledBy: currentUser.uid, handledAt: serverTimestamp() }, { merge: true });
  await logActivity("user", `Demande refusée : ${req?.name || "Compte"}`, { targetUid: uid });
};

function nameByUid(uid) {
  if (!uid) return "";
  return players.find((p) => p.uid === uid)?.name || registeredUsers.find((p) => p.uid === uid)?.name || "";
}

async function logActivity(type, message, extra = {}) {
  if (!db || !currentUser) return;
  try {
    await addDoc(teamCollection("activityLog"), {
      type,
      message,
      userId: currentUser.uid,
      userName: currentProfile?.name || currentUser.displayName || "Compte",
      createdAt: serverTimestamp(),
      ...extra
    });
  } catch (err) {
    console.warn("Historique non enregistré", err);
  }
}

function renderActivityLog() {
  const wrap = $("activityLogWrap");
  if (!wrap) return;
  if (currentProfile?.role !== "admin") {
    wrap.innerHTML = `<p class="muted">Historique réservé aux admins.</p>`;
    return;
  }
  if (!activityLog.length) {
    wrap.innerHTML = `<p class="muted">Aucun changement enregistré pour le moment.</p>`;
    return;
  }
  wrap.innerHTML = activityLog.map((a) => {
    const date = formatLogDate(a.createdAt);
    return `<div class="activity-item activity-${escapeAttr(a.type || "info")}">
      <div><strong>${escapeHtml(a.message || "Changement")}</strong><br><span>${escapeHtml(a.userName || "Compte")}</span></div>
      <time>${escapeHtml(date)}</time>
    </div>`;
  }).join("");
}

function formatLogDate(value) {
  const d = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  if (!d || !Number.isFinite(d.getTime())) return "À l’instant";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function initTheme() {
  const saved = localStorage.getItem("r6-theme") || "dark";
  document.body.classList.toggle("light-theme", saved === "light");
  updateThemeLabel();
}

function toggleTheme() {
  const next = document.body.classList.contains("light-theme") ? "dark" : "light";
  localStorage.setItem("r6-theme", next);
  document.body.classList.toggle("light-theme", next === "light");
  updateThemeLabel();
}

function updateThemeLabel() {
  const btn = $("themeToggleBtn");
  if (!btn) return;
  btn.textContent = document.body.classList.contains("light-theme") ? "Mode sombre" : "Mode clair";
}

function roleLabel(role) { return { admin: "Admin", player: "Joueur", viewer: "Lecture seule", pending: "En attente", rejected: "Refusé" }[role] || "Lecture seule"; }
function guessName(email) { return (email || "joueur").split("@")[0]; }
function safeKey(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9_-]/g, "_"); }
function setMsg(id, text) { $(id).textContent = text || ""; }
function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function kd(k, d) { return d ? (num(k) / num(d)).toFixed(2) : String(num(k)); }
function hsPercentValue(headshots, kills) {
  const k = num(kills);
  if (!k) return 0;
  return Math.min(100, Math.max(0, (num(headshots) / k) * 100));
}
function hsPercent(headshots, kills) { return `${Math.round(hsPercentValue(headshots, kills))}%`; }
function escapeHtml(str) { return String(str ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function escapeAttr(str) { return escapeHtml(str).replace(/'/g, "&#39;"); }
function humanError(err) {
  console.error(err);
  if (String(err?.code || "").includes("permission-denied")) return "Permission refusée : vérifie les règles Firestore.";
  if (String(err?.code || "").includes("auth")) return "Erreur de connexion : vérifie email/mot de passe.";
  return err?.message || "Erreur inconnue.";
}
