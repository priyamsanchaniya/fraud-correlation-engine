import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import * as d3 from "d3";
import * as XLSX from "xlsx";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import {
  AlertTriangle, MapPin, Shield, IndianRupee, Phone, CreditCard,
  ArrowLeft, Search, Plus, X, CheckCircle2, Loader2, AlertCircle, Trash2,
  LogOut, Lock, UserPlus, Eye, EyeOff, KeyRound, BarChart3, Upload, Download,
  FileSpreadsheet,
} from "lucide-react";

// ---------------------------------------------------------------------
// EMBEDDED BASE CASE DATA (all 311 synthetic complaints, isolated + ring)
// New complaints entered through the "+ New Complaint" form are saved
// to persistent storage and merged with this base set on every load.
// ---------------------------------------------------------------------
const ALL_COMPLAINTS = []; // no longer used for data - kept only so any
// leftover references in this file don't crash. Real data now comes from
// the backend API below.

// ---------------------------------------------------------------------
// BACKEND API CLIENT
// -----------------------------------------------------------------------
// Change API_BASE to wherever your Flask backend is running:
//   - Local testing:  "http://localhost:5000"
//   - Deployed backend: "https://your-backend.onrender.com" (or wherever
//     you deploy it - see backend/README.md)
// ---------------------------------------------------------------------
const API_BASE = "http://localhost:5000";

class APIError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function apiRequest(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new APIError(
      `Could not reach the backend at ${API_BASE}. Is it running? (${e.message})`,
      0
    );
  }

  let data = null;
  try { data = await res.json(); } catch (e) { /* empty response body */ }

  if (!res.ok) {
    const msg = data?.error || (data?.errors ? Object.values(data.errors)[0] : `Request failed (${res.status})`);
    throw new APIError(msg, res.status);
  }
  return data;
}

const api = {
  signup: (payload) => apiRequest("/api/signup", { method: "POST", body: payload }),
  login: (payload) => apiRequest("/api/login", { method: "POST", body: payload }),
  listComplaints: (token) => apiRequest("/api/complaints", { token }),
  createComplaint: (payload, token) => apiRequest("/api/complaints", { method: "POST", body: payload, token }),
  updateComplaint: (id, payload, token) => apiRequest(`/api/complaints/${id}`, { method: "PUT", body: payload, token }),
  deleteComplaint: (id, token) => apiRequest(`/api/complaints/${id}`, { method: "DELETE", token }),
  bulkUpload: (rows, token) => apiRequest("/api/complaints/bulk", { method: "POST", body: { rows }, token }),
  getRings: (token) => apiRequest("/api/rings", { token }),
  getMuleClusters: (token) => apiRequest("/api/mule-clusters", { token }),
  getMOPatterns: (token) => apiRequest("/api/mo-patterns", { token }),
  getAnalytics: (token) => apiRequest("/api/analytics", { token }),
};



const FRAUD_TYPES = [
  "UPI Fraud - Fake QR Code", "Loan App Harassment", "Investment/Trading Scam",
  "Digital Arrest Scam", "OTP Fraud", "Fake Job Offer Fraud", "KYC Update Scam",
  "Online Shopping Fraud", "Matrimonial Fraud", "Sextortion",
];

const INDIAN_STATES = [
  "Andhra Pradesh", "Bihar", "Delhi", "Gujarat", "Karnataka", "Madhya Pradesh",
  "Maharashtra", "Rajasthan", "Tamil Nadu", "Telangana", "Uttar Pradesh", "West Bengal",
];

function riskLevel(ring) {
  if (ring.cross_state && ring.size >= 8) return "critical";
  if (ring.cross_state && ring.size >= 4) return "high";
  if (ring.size >= 4) return "medium";
  return "low";
}
const RISK_STYLES = {
  critical: { color: "#E8543F", label: "CRITICAL", glow: "rgba(232,84,63,0.35)" },
  high: { color: "#D4A544", label: "HIGH", glow: "rgba(212,165,68,0.3)" },
  medium: { color: "#4A9B8E", label: "MEDIUM", glow: "rgba(74,155,142,0.25)" },
  low: { color: "#6B7A8F", label: "LOW", glow: "rgba(107,122,143,0.2)" },
};
function fmtINR(n) { return "₹" + n.toLocaleString("en-IN"); }

// ---------------------------------------------------------------------
// VALIDATION (mirrors correlation_engine.py rules)
// ---------------------------------------------------------------------
const PHONE_RE = /^\+91\d{10}$/;
const UPI_RE = /^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/;
const ACCOUNT_RE = /^\d{9,18}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

function validateComplaint(form) {
  const errors = {};
  if (!form.state.trim()) errors.state = "State is required";
  if (!form.city.trim()) errors.city = "City is required";
  if (!form.victim_name.trim()) errors.victim_name = "Victim name is required";
  if (!form.fraud_type) errors.fraud_type = "Fraud type is required";
  if (!form.amount_lost_inr || Number(form.amount_lost_inr) <= 0) errors.amount_lost_inr = "Enter a valid amount";

  if (form.phone_used_by_fraudster && !PHONE_RE.test(form.phone_used_by_fraudster)) {
    errors.phone_used_by_fraudster = "Format: +91 followed by 10 digits";
  }
  if (form.upi_id && !UPI_RE.test(form.upi_id)) {
    errors.upi_id = "Format: name@bankhandle";
  }
  if (form.bank_account && !ACCOUNT_RE.test(form.bank_account)) {
    errors.bank_account = "9-18 digits only";
  }
  if (form.ifsc_code && !IFSC_RE.test(form.ifsc_code)) {
    errors.ifsc_code = "Format: 4 letters + 0 + 6 alphanumeric (e.g. SBIN0001234)";
  }
  const hasAnyIdentifier = form.phone_used_by_fraudster || form.upi_id || form.bank_account || form.ifsc_code;
  if (!hasAnyIdentifier) {
    errors._identifier = "Enter at least one identifier (phone, UPI, account, or IFSC) so this complaint can be correlated";
  }
  return errors;
}

// ---------------------------------------------------------------------
// JS CORRELATION ENGINE (mirrors correlation_engine.py build_correlation_graph)
// ---------------------------------------------------------------------
// NOTE: IFSC (bank branch code) is deliberately NOT included here.
// An IFSC alone is shared by thousands of unrelated customers at that
// branch, so two complaints matching only on IFSC are NOT good evidence
// of a real fraud ring - including it here would create logically
// meaningless "rings" (two random victims who happen to bank at the
// same branch). IFSC-based patterns are handled separately and more
// carefully by buildMuleClusters() below, which only flags a branch
// when 3+ DISTINCT account numbers appear across different complaints -
// a much stronger and more honest signal than a single shared IFSC.
const MATCH_WEIGHTS = {
  phone_used_by_fraudster: 0.9,
  upi_id: 0.9,
  bank_account: 0.95,
};

function buildCorrelation(complaints) {
  const idFields = Object.keys(MATCH_WEIGHTS);
  const index = {};
  idFields.forEach((f) => (index[f] = new Map()));

  complaints.forEach((c) => {
    idFields.forEach((f) => {
      const val = (c[f] || "").trim();
      if (!val) return;
      if (!index[f].has(val)) index[f].set(val, []);
      index[f].get(val).push(c.complaint_id);
    });
  });

  // pairKey -> [{field, value}]
  const edgeReasons = new Map();
  idFields.forEach((f) => {
    index[f].forEach((ids, val) => {
      if (ids.length < 2) return;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = [ids[i], ids[j]].sort().join("|");
          if (!edgeReasons.has(key)) edgeReasons.set(key, []);
          edgeReasons.get(key).push({ field: f, value: val });
        }
      }
    });
  });

  const adjacency = new Map(); // id -> Set(id)
  const edgeMeta = new Map(); // "a|b" -> {confidence, reasons}
  complaints.forEach((c) => adjacency.set(c.complaint_id, new Set()));

  edgeReasons.forEach((reasons, key) => {
    const [a, b] = key.split("|");
    let combined = 1.0;
    reasons.forEach((r) => (combined *= 1 - MATCH_WEIGHTS[r.field]));
    const confidence = Math.round((1 - combined) * 1000) / 1000;
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
    edgeMeta.set(key, { confidence, reasons: reasons.map((r) => r.field) });
  });

  // connected components (BFS)
  const visited = new Set();
  const complaintById = new Map(complaints.map((c) => [c.complaint_id, c]));
  const clusters = [];

  complaints.forEach((c) => {
    if (visited.has(c.complaint_id)) return;
    const stack = [c.complaint_id];
    const component = [];
    visited.add(c.complaint_id);
    while (stack.length) {
      const cur = stack.pop();
      component.push(cur);
      adjacency.get(cur).forEach((n) => {
        if (!visited.has(n)) {
          visited.add(n);
          stack.push(n);
        }
      });
    }
    if (component.length < 2) return; // only interested in actual rings for the sidebar

    component.sort();
    const nodes = component.map((id) => {
      const rec = complaintById.get(id);
      return {
        id: rec.complaint_id,
        state: rec.state,
        city: rec.city,
        victim: rec.victim_name,
        fraud_type: rec.fraud_type,
        phone: rec.phone_used_by_fraudster,
        upi: rec.upi_id,
        account: rec.bank_account,
        ifsc: rec.ifsc_code,
        amount: rec.amount_lost_inr,
        date: rec.date_filed,
        mo: rec.mo_description,
      };
    });

    const edges = [];
    let confSum = 0, confCount = 0;
    for (let i = 0; i < component.length; i++) {
      for (let j = i + 1; j < component.length; j++) {
        const key = [component[i], component[j]].sort().join("|");
        if (edgeMeta.has(key)) {
          const meta = edgeMeta.get(key);
          edges.push({ source: component[i], target: component[j], confidence: meta.confidence, reasons: meta.reasons });
          confSum += meta.confidence;
          confCount += 1;
        }
      }
    }

    const states = [...new Set(nodes.map((n) => n.state))].sort();
    const totalLoss = nodes.reduce((s, n) => s + (n.amount || 0), 0);

    clusters.push({
      cluster_id: null, // assigned after sort
      size: component.length,
      states,
      cross_state: states.length > 1,
      avg_confidence: confCount ? Math.round((confSum / confCount) * 1000) / 1000 : 0,
      total_loss: totalLoss,
      nodes,
      edges,
      member_ids: component,
    });
  });

  clusters.sort((a, b) => {
    if (a.cross_state !== b.cross_state) return b.cross_state - a.cross_state;
    if (a.size !== b.size) return b.size - a.size;
    return b.total_loss - a.total_loss;
  });
  clusters.forEach((c, i) => (c.cluster_id = `CLUSTER-${String(i + 1).padStart(3, "0")}`));

  return clusters;
}

// ---------------------------------------------------------------------
// MULE ACCOUNT CLUSTER DETECTION (secondary, weaker-confidence layer)
// -----------------------------------------------------------------------
// A fraud ring rarely reuses the same bank account for long - mule
// accounts (opened by recruited/coerced individuals) are typically used
// briefly then abandoned. So the same-account/same-phone/same-UPI exact
// match above will usually MISS a gang that uses many different mule
// accounts. What often stays constant, though, is WHERE those accounts
// were opened: gangs frequently recruit many mules through the same
// local agent/bank branch. This function flags branches (IFSC codes)
// that show up across an unusually high number of DISTINCT accounts in
// DIFFERENT complaints - a pattern worth an officer's manual review,
// not a confirmed link like the identifier-based rings above.
//
// IMPORTANT LIMITATION: this is a proxy signal based only on what a
// victim's complaint records (their own transfer's IFSC). It cannot see
// the actual money trail (which account paid which account after that) -
// that requires real bank transaction data, obtainable only through a
// formal legal request (see the identity-verification note elsewhere in
// this app). Treat every result here as "worth investigating", not
// "confirmed mule ring".
// ---------------------------------------------------------------------
function buildMuleClusters(complaints, minDistinctAccounts = 3) {
  const byIfsc = new Map(); // ifsc -> Map(account -> [complaint_ids])

  complaints.forEach((c) => {
    const ifsc = (c.ifsc_code || "").trim();
    const account = (c.bank_account || "").trim();
    if (!ifsc || !account) return; // need both to say "different account, same branch"
    if (!byIfsc.has(ifsc)) byIfsc.set(ifsc, new Map());
    const accMap = byIfsc.get(ifsc);
    if (!accMap.has(account)) accMap.set(account, []);
    accMap.get(account).push(c);
  });

  const clusters = [];
  byIfsc.forEach((accMap, ifsc) => {
    const distinctAccounts = accMap.size;
    if (distinctAccounts < minDistinctAccounts) return; // not enough spread to be suspicious

    const allComplaints = [];
    accMap.forEach((list) => allComplaints.push(...list));

    const states = [...new Set(allComplaints.map((c) => c.state))].sort();
    const totalLoss = allComplaints.reduce((s, c) => s + (Number(c.amount_lost_inr) || 0), 0);
    const bankGuess = ifsc.slice(0, 4);

    // -------------------------------------------------------------
    // EVIDENCE SIGNALS - each one that fires is concrete, checkable
    // evidence added to the flag. This is what "catching" a pattern
    // actually looks like: naming the specific evidence, not a
    // vague percentage.
    // -------------------------------------------------------------
    const evidence = [];

    evidence.push(`${distinctAccounts} different account numbers at the same branch (${ifsc}) across ${allComplaints.length} separate complaints.`);

    // Signal: accounts opened/used within a tight time window (bulk mule recruitment)
    const dates = allComplaints.map((c) => c.date_filed).filter(Boolean).sort();
    let tightWindow = false;
    if (dates.length >= 2) {
      const first = new Date(dates[0]);
      const last = new Date(dates[dates.length - 1]);
      const spreadDays = Math.round((last - first) / (1000 * 60 * 60 * 24));
      if (spreadDays <= 30) {
        tightWindow = true;
        evidence.push(`All ${allComplaints.length} complaints were filed within a ${spreadDays}-day window - consistent with a batch of mules recruited and used together.`);
      }
    }

    // Signal: account numbers are numerically close together (often means
    // they were opened in bulk, back-to-back, at the same branch)
    const numericAccounts = [...accMap.keys()].map((a) => Number(a)).filter((n) => !isNaN(n)).sort((a, b) => a - b);
    let sequential = false;
    if (numericAccounts.length >= 3) {
      const gaps = [];
      for (let i = 1; i < numericAccounts.length; i++) gaps.push(numericAccounts[i] - numericAccounts[i - 1]);
      const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      if (avgGap > 0 && avgGap < 500) {
        sequential = true;
        evidence.push(`Account numbers are numerically close together (avg. gap ${Math.round(avgGap)}) - a common sign of accounts opened in bulk at the same time.`);
      }
    }

    // Signal: spans multiple states (mule network serving a multi-state gang)
    if (states.length > 1) {
      evidence.push(`Victims are spread across ${states.length} different states (${states.join(", ")}), so this is not just local coincidence.`);
    }

    // Decide the flag level from how many independent signals fired
    const signalCount = 1 + (tightWindow ? 1 : 0) + (sequential ? 1 : 0) + (states.length > 1 ? 1 : 0);
    const flag = signalCount >= 3 ? "SUSPECTED MULE NETWORK" : signalCount === 2 ? "POSSIBLE MULE NETWORK" : "WORTH REVIEWING";

    clusters.push({
      ifsc,
      bank_code: bankGuess,
      distinct_accounts: distinctAccounts,
      accounts: [...accMap.keys()],
      complaint_count: allComplaints.length,
      states,
      cross_state: states.length > 1,
      total_loss: totalLoss,
      flag,
      signal_count: signalCount,
      evidence,
      complaints: allComplaints.map((c) => ({
        id: c.complaint_id, state: c.state, city: c.city, victim: c.victim_name,
        account: c.bank_account, amount: c.amount_lost_inr, date: c.date_filed,
        fraud_type: c.fraud_type,
      })),
    });
  });

  clusters.sort((a, b) => b.signal_count - a.signal_count || b.distinct_accounts - a.distinct_accounts || b.total_loss - a.total_loss);
  return clusters;
}

// ---------------------------------------------------------------------
// ANALYTICS AGGREGATION
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// MO (MODUS OPERANDI) TEXT SIMILARITY DETECTION
// -----------------------------------------------------------------------
// Purpose: catch a gang that uses a DIFFERENT phone/UPI/account for
// every victim (so the exact-match engine above sees no shared
// identifier at all), but reuses the same SCRIPT - the same lies, the
// same threats, the same sequence of steps. Scam gangs often work from
// a fixed script, so victims' descriptions of "what happened" end up
// strikingly similar in wording even when every technical identifier
// differs.
//
// Method: simple, dependency-free text similarity (Jaccard similarity
// over word sets, after basic cleanup) between every pair of MO
// descriptions. This is intentionally simple - no ML model, no
// external API - so it runs instantly in-browser. It is a genuinely
// useful FIRST PASS filter that most complaint-management systems do
// not attempt at all, but it is still a proxy signal: high textual
// similarity is a reason to have a human compare the two cases, not
// standalone proof of a connection.
// ---------------------------------------------------------------------
const STOPWORDS = new Set([
  "the","a","an","and","or","to","of","in","on","for","was","were","is","are",
  "he","she","they","victim","fraudster","then","after","with","from","that",
  "this","his","her","their","had","have","has","it","as","by","at","be","been",
]);

function tokenize(text) {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  setA.forEach((w) => { if (setB.has(w)) intersection += 1; });
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function buildMOPatternClusters(complaints, similarityThreshold = 0.45) {
  const withText = complaints
    .map((c) => ({ c, tokens: tokenize(c.mo_description) }))
    .filter((x) => x.tokens.size >= 4); // need enough words to compare meaningfully

  const adjacency = new Map();
  withText.forEach((x) => adjacency.set(x.c.complaint_id, new Set()));
  const edgeSim = new Map();

  for (let i = 0; i < withText.length; i++) {
    for (let j = i + 1; j < withText.length; j++) {
      const a = withText[i], b = withText[j];
      const sim = jaccardSimilarity(a.tokens, b.tokens);
      if (sim >= similarityThreshold) {
        adjacency.get(a.c.complaint_id).add(b.c.complaint_id);
        adjacency.get(b.c.complaint_id).add(a.c.complaint_id);
        edgeSim.set([a.c.complaint_id, b.c.complaint_id].sort().join("|"), sim);
      }
    }
  }

  const visited = new Set();
  const byId = new Map(withText.map((x) => [x.c.complaint_id, x.c]));
  const clusters = [];

  withText.forEach((x) => {
    const id = x.c.complaint_id;
    if (visited.has(id)) return;
    const stack = [id];
    const component = [];
    visited.add(id);
    while (stack.length) {
      const cur = stack.pop();
      component.push(cur);
      adjacency.get(cur).forEach((n) => {
        if (!visited.has(n)) { visited.add(n); stack.push(n); }
      });
    }
    if (component.length < 2) return;

    let simSum = 0, simCount = 0;
    for (let i = 0; i < component.length; i++) {
      for (let j = i + 1; j < component.length; j++) {
        const key = [component[i], component[j]].sort().join("|");
        if (edgeSim.has(key)) { simSum += edgeSim.get(key); simCount += 1; }
      }
    }

    const members = component.map((id) => byId.get(id));
    const states = [...new Set(members.map((c) => c.state))].sort();
    const totalLoss = members.reduce((s, c) => s + (Number(c.amount_lost_inr) || 0), 0);

    clusters.push({
      pattern_id: null,
      size: component.length,
      avg_similarity: simCount ? Math.round((simSum / simCount) * 100) / 100 : 0,
      states,
      cross_state: states.length > 1,
      total_loss: totalLoss,
      complaints: members.map((c) => ({
        id: c.complaint_id, state: c.state, city: c.city, fraud_type: c.fraud_type,
        amount: c.amount_lost_inr, mo: c.mo_description,
        phone: c.phone_used_by_fraudster, upi: c.upi_id, account: c.bank_account,
      })),
    });
  });

  clusters.sort((a, b) => b.avg_similarity - a.avg_similarity || b.size - a.size);
  clusters.forEach((c, i) => (c.pattern_id = `PATTERN-${String(i + 1).padStart(3, "0")}`));
  return clusters;
}

function buildAnalytics(complaints) {
  const byState = new Map();
  const byFraudType = new Map();
  const byMonth = new Map();
  let totalLoss = 0;

  complaints.forEach((c) => {
    const amt = Number(c.amount_lost_inr) || 0;
    totalLoss += amt;

    const st = c.state || "Unknown";
    if (!byState.has(st)) byState.set(st, { state: st, complaints: 0, loss: 0 });
    byState.get(st).complaints += 1;
    byState.get(st).loss += amt;

    const ft = c.fraud_type || "Unknown";
    if (!byFraudType.has(ft)) byFraudType.set(ft, { type: ft, count: 0 });
    byFraudType.get(ft).count += 1;

    const month = (c.date_filed || "").slice(0, 7); // YYYY-MM
    if (month) {
      if (!byMonth.has(month)) byMonth.set(month, { month, complaints: 0, loss: 0 });
      byMonth.get(month).complaints += 1;
      byMonth.get(month).loss += amt;
    }
  });

  const stateData = [...byState.values()].sort((a, b) => b.complaints - a.complaints).slice(0, 10);
  const fraudTypeData = [...byFraudType.values()].sort((a, b) => b.count - a.count);
  const monthData = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

  return {
    totalComplaints: complaints.length,
    totalLoss,
    avgLoss: complaints.length ? Math.round(totalLoss / complaints.length) : 0,
    statesAffected: byState.size,
    stateData,
    fraudTypeData,
    monthData,
  };
}

const CHART_COLORS = ["#4A9B8E", "#D4A544", "#E8543F", "#6B7A8F", "#8A93A3", "#2E7D6E", "#B8860B", "#C0392B"];

// ---------------------------------------------------------------------
// FORCE-DIRECTED GRAPH
// ---------------------------------------------------------------------
function RingGraph({ ring, onSelectNode, selectedNodeId, highlightId }) {
  const containerRef = useRef(null);
  const [dims, setDims] = useState({ w: 800, h: 520 });
  const [positions, setPositions] = useState(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDims({ w: Math.max(width, 300), h: Math.max(height, 300) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!ring) return;
    const nodes = ring.nodes.map((n) => ({ ...n }));
    const links = ring.edges.map((e) => ({ ...e }));
    const sim = d3
      .forceSimulation(nodes)
      .force("link", d3.forceLink(links).id((d) => d.id).distance((d) => 140 - d.confidence * 60).strength((d) => 0.3 + d.confidence * 0.5))
      .force("charge", d3.forceManyBody().strength(-260))
      .force("center", d3.forceCenter(dims.w / 2, dims.h / 2))
      .force("collide", d3.forceCollide(34))
      .stop();
    for (let i = 0; i < 300; i++) sim.tick();
    setPositions({ nodes, links });
  }, [ring, dims.w, dims.h]);

  if (!ring || !positions) {
    return (
      <div ref={containerRef} className="graph-empty">
        <Shield size={40} strokeWidth={1.2} />
        <p>Select a case cluster to render the link graph</p>
      </div>
    );
  }
  const riskStyle = RISK_STYLES[riskLevel(ring)];

  return (
    <div ref={containerRef} className="graph-canvas">
      <svg width={dims.w} height={dims.h} viewBox={`0 0 ${dims.w} ${dims.h}`}>
        <defs>
          <filter id="node-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {positions.links.map((l, i) => (
          <line key={i} x1={l.source.x} y1={l.source.y} x2={l.target.x} y2={l.target.y}
            stroke="#4A9B8E" strokeOpacity={0.15 + l.confidence * 0.45} strokeWidth={0.6 + l.confidence * 2.2} />
        ))}
        {positions.nodes.map((n) => {
          const isSelected = n.id === selectedNodeId;
          const isNew = n.id === highlightId;
          return (
            <g key={n.id} transform={`translate(${n.x},${n.y})`} className="graph-node" onClick={() => onSelectNode(n.id)}>
              {isNew && <circle r={20} fill="none" stroke="#D4A544" strokeWidth={1.5} className="pulse-ring" />}
              <circle r={isSelected ? 15 : 11}
                fill={isSelected ? riskStyle.color : isNew ? "#D4A544" : "#151B26"}
                stroke={isNew ? "#D4A544" : riskStyle.color}
                strokeWidth={isSelected || isNew ? 2.5 : 1.5}
                filter={isSelected || isNew ? "url(#node-glow)" : undefined} />
              <text y={-16} textAnchor="middle" className="node-label" fill={isSelected ? "#F2F4F7" : "#8A93A3"}>
                {n.id.replace("CMP-", "")}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------
// NEW COMPLAINT FORM (modal)
// ---------------------------------------------------------------------
function emptyForm() {
  return {
    state: "", city: "", victim_name: "", fraud_type: "",
    phone_used_by_fraudster: "", upi_id: "", bank_account: "", ifsc_code: "",
    amount_lost_inr: "", mo_description: "",
  };
}

function NewComplaintModal({ onClose, onSubmit, submitting, initialData, isEdit }) {
  const [form, setForm] = useState(() => initialData ? { ...emptyForm(), ...initialData } : emptyForm());
  const [errors, setErrors] = useState({});

  const update = (field, value) => setForm((f) => ({ ...f, [field]: value }));

  const handleSubmit = () => {
    const errs = validateComplaint(form);
    setErrors(errs);
    if (Object.keys(errs).length === 0) {
      onSubmit(form);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{isEdit ? <><CheckCircle2 size={16} /> Edit Complaint</> : <><Plus size={16} /> New Complaint Intake</>}</div>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <div className="form-field">
              <label>State *</label>
              <select value={form.state} onChange={(e) => update("state", e.target.value)}>
                <option value="">Select state</option>
                {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              {errors.state && <span className="err">{errors.state}</span>}
            </div>
            <div className="form-field">
              <label>City *</label>
              <input value={form.city} onChange={(e) => update("city", e.target.value)} placeholder="e.g. Surat" />
              {errors.city && <span className="err">{errors.city}</span>}
            </div>
            <div className="form-field">
              <label>Victim name *</label>
              <input value={form.victim_name} onChange={(e) => update("victim_name", e.target.value)} placeholder="Full name" />
              {errors.victim_name && <span className="err">{errors.victim_name}</span>}
            </div>
            <div className="form-field">
              <label>Fraud type *</label>
              <select value={form.fraud_type} onChange={(e) => update("fraud_type", e.target.value)}>
                <option value="">Select type</option>
                {FRAUD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              {errors.fraud_type && <span className="err">{errors.fraud_type}</span>}
            </div>
            <div className="form-field">
              <label>Amount lost (₹) *</label>
              <input type="number" value={form.amount_lost_inr} onChange={(e) => update("amount_lost_inr", e.target.value)} placeholder="e.g. 45000" />
              {errors.amount_lost_inr && <span className="err">{errors.amount_lost_inr}</span>}
            </div>
            <div className="form-field">
              <label>Fraudster phone</label>
              <input value={form.phone_used_by_fraudster} onChange={(e) => update("phone_used_by_fraudster", e.target.value)} placeholder="+919876543210" />
              {errors.phone_used_by_fraudster && <span className="err">{errors.phone_used_by_fraudster}</span>}
            </div>
            <div className="form-field">
              <label>UPI ID</label>
              <input value={form.upi_id} onChange={(e) => update("upi_id", e.target.value)} placeholder="name@bank" />
              {errors.upi_id && <span className="err">{errors.upi_id}</span>}
            </div>
            <div className="form-field">
              <label>Bank account</label>
              <input value={form.bank_account} onChange={(e) => update("bank_account", e.target.value)} placeholder="9-18 digit account no." />
              {errors.bank_account && <span className="err">{errors.bank_account}</span>}
            </div>
            <div className="form-field">
              <label>IFSC code</label>
              <input value={form.ifsc_code} onChange={(e) => update("ifsc_code", e.target.value.toUpperCase())} placeholder="SBIN0001234" />
              {errors.ifsc_code && <span className="err">{errors.ifsc_code}</span>}
            </div>
          </div>
          <div className="form-field" style={{ marginTop: 12 }}>
            <label>Modus operandi</label>
            <textarea rows={3} value={form.mo_description} onChange={(e) => update("mo_description", e.target.value)} placeholder="Describe how the fraud was carried out..." />
          </div>
          {errors._identifier && <div className="err" style={{ marginTop: 8 }}><AlertCircle size={12} style={{ display: "inline", marginRight: 4 }} />{errors._identifier}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={submitting}>
            {submitting
              ? <><Loader2 size={14} className="spin" /> {isEdit ? "Saving..." : "Correlating..."}</>
              : (isEdit ? "Save Changes" : "Submit & Correlate")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// BULK CSV / EXCEL UPLOAD
// -----------------------------------------------------------------------
// Lets an officer upload a spreadsheet of many complaints at once instead
// of typing each one manually - the single biggest real time-saver for
// an office dealing with volume. Accepts .csv, .xlsx, .xls. Expected
// column headers (case-insensitive, order doesn't matter):
//   state, city, victim_name, fraud_type, amount_lost_inr,
//   phone_used_by_fraudster, upi_id, bank_account, ifsc_code,
//   mo_description, date_filed (optional - defaults to today)
// Every row is validated with the exact same rules as the manual form -
// bulk upload does not bypass validation, it just does it for many rows
// at once and reports which rows failed and why.
// ---------------------------------------------------------------------
const CSV_TEMPLATE_HEADERS = [
  "state", "city", "victim_name", "fraud_type", "amount_lost_inr",
  "phone_used_by_fraudster", "upi_id", "bank_account", "ifsc_code",
  "mo_description", "date_filed",
];

function downloadCSVTemplate() {
  const sampleRow = [
    "Gujarat", "Ahmedabad", "Ramesh Patel", "Digital Arrest Scam", "85000",
    "+919876543210", "example@ybl", "123456789012", "SBIN0001234",
    "Fraudster posed as CBI officer and threatened arrest", "2026-08-01",
  ];
  const ws = XLSX.utils.aoa_to_sheet([CSV_TEMPLATE_HEADERS, sampleRow]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Complaints");
  XLSX.writeFile(wb, "complaint_upload_template.xlsx");
}

function normalizeRowKeys(row) {
  const out = {};
  Object.keys(row).forEach((k) => {
    const norm = k.trim().toLowerCase().replace(/\s+/g, "_");
    out[norm] = row[k];
  });
  return out;
}

function BulkUploadModal({ onClose, onConfirm, uploading }) {
  const fileInputRef = useRef(null);
  const [fileName, setFileName] = useState("");
  const [parsedRows, setParsedRows] = useState([]); // { row, errors, valid }
  const [parseError, setParseError] = useState("");

  const handleFile = (file) => {
    setParseError("");
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

        if (rows.length === 0) {
          setParseError("The file appears to be empty.");
          setParsedRows([]);
          return;
        }
        if (rows.length > 1000) {
          setParseError(`File has ${rows.length} rows - please upload 1000 or fewer at a time.`);
          setParsedRows([]);
          return;
        }

        const results = rows.map((raw, i) => {
          const row = normalizeRowKeys(raw);
          const form = {
            state: String(row.state || "").trim(),
            city: String(row.city || "").trim(),
            victim_name: String(row.victim_name || "").trim(),
            fraud_type: String(row.fraud_type || "").trim(),
            amount_lost_inr: String(row.amount_lost_inr || "").trim(),
            phone_used_by_fraudster: String(row.phone_used_by_fraudster || "").trim(),
            upi_id: String(row.upi_id || "").trim(),
            bank_account: String(row.bank_account || "").trim(),
            ifsc_code: String(row.ifsc_code || "").trim().toUpperCase(),
            mo_description: String(row.mo_description || "").trim(),
            date_filed: String(row.date_filed || "").trim(),
          };
          const errors = validateComplaint(form);
          return { rowNum: i + 2, form, errors, valid: Object.keys(errors).length === 0 }; // +2 = header row + 1-index
        });

        setParsedRows(results);
      } catch (err) {
        setParseError("Could not read this file. Make sure it's a valid .csv or .xlsx file.");
        setParsedRows([]);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const validCount = parsedRows.filter((r) => r.valid).length;
  const invalidCount = parsedRows.length - validCount;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title"><FileSpreadsheet size={16} /> Bulk Upload Complaints</div>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="bulk-intro">
            Upload a .csv or .xlsx file with multiple complaints at once. Each row is validated with the
            same rules as manual entry.
            <button className="template-link" onClick={downloadCSVTemplate}>
              <Download size={12} style={{ marginRight: 4 }} />Download template
            </button>
          </div>

          <div
            className="dropzone"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
          >
            <Upload size={22} color="#5B6577" />
            <div style={{ marginTop: 8, fontSize: 12.5, color: "#8A93A3" }}>
              {fileName ? fileName : "Click to choose a file, or drag and drop"}
            </div>
            <div style={{ fontSize: 10.5, color: "#5B6577", marginTop: 4 }}>.csv, .xlsx, .xls — up to 1000 rows</div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              style={{ display: "none" }}
              onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])}
            />
          </div>

          {parseError && <div className="err" style={{ marginTop: 10 }}>{parseError}</div>}

          {parsedRows.length > 0 && (
            <>
              <div className="bulk-summary">
                <span style={{ color: "#4A9B8E" }}><CheckCircle2 size={13} style={{ display: "inline", marginRight: 4 }} />{validCount} valid</span>
                {invalidCount > 0 && <span style={{ color: "#E8543F", marginLeft: 14 }}><AlertCircle size={13} style={{ display: "inline", marginRight: 4 }} />{invalidCount} row(s) have errors</span>}
              </div>
              <div className="bulk-table-wrap">
                <table className="mule-table">
                  <thead><tr><th>Row</th><th>State/City</th><th>Victim</th><th>Amount</th><th>Status</th></tr></thead>
                  <tbody>
                    {parsedRows.map((r) => (
                      <tr key={r.rowNum}>
                        <td className="mono">{r.rowNum}</td>
                        <td>{r.form.city}, {r.form.state}</td>
                        <td>{r.form.victim_name || "—"}</td>
                        <td className="mono">{r.form.amount_lost_inr || "—"}</td>
                        <td>
                          {r.valid
                            ? <span style={{ color: "#4A9B8E" }}>OK</span>
                            : <span style={{ color: "#E8543F" }} title={Object.values(r.errors).join("; ")}>{Object.values(r.errors)[0]}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={uploading || validCount === 0}
            onClick={() => onConfirm(parsedRows.filter((r) => r.valid).map((r) => r.form))}
          >
            {uploading ? <><Loader2 size={14} className="spin" /> Uploading...</> : `Upload ${validCount} Valid Complaint(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// MAIN DASHBOARD
// ---------------------------------------------------------------------
function Dashboard({ currentUser, authToken, onLogout }) {
  const [allComplaints, setAllComplaints] = useState([]);
  const [rings, setRings] = useState([]);
  const [muleClusters, setMuleClusters] = useState([]);
  const [moPatternClusters, setMoPatternClusters] = useState([]);
  const [analyticsRaw, setAnalyticsRaw] = useState(null);
  const [loadingStorage, setLoadingStorage] = useState(true);
  const [apiErrorBanner, setApiErrorBanner] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editingComplaint, setEditingComplaint] = useState(null); // complaint object being edited, or null
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);
  const [selectedRingId, setSelectedRingId] = useState(null);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState("rings"); // "rings" | "mules" | "analytics" | "all" | "patterns"
  const [selectedMuleIfsc, setSelectedMuleIfsc] = useState(null);
  const [selectedAllComplaintId, setSelectedAllComplaintId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [highlightId, setHighlightId] = useState(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Pulls fresh complaints + computed rings/mule-clusters/patterns/analytics
  // from the backend. Called on mount and after every create/edit/delete/
  // bulk-upload so the UI always reflects what's actually in the database
  // (and, since this is a real backend, what every other officer sees too).
  const refreshAll = useCallback(async () => {
    try {
      const [complaints, ringsData, mulesData, patternsData, analyticsData] = await Promise.all([
        api.listComplaints(authToken),
        api.getRings(authToken),
        api.getMuleClusters(authToken),
        api.getMOPatterns(authToken),
        api.getAnalytics(authToken),
      ]);
      setAllComplaints(complaints);
      setRings(ringsData);
      setMuleClusters(mulesData);
      setMoPatternClusters(patternsData);
      setAnalyticsRaw(analyticsData);
      setApiErrorBanner("");
    } catch (e) {
      setApiErrorBanner(e.message || "Could not reach the backend.");
    }
  }, [authToken]);

  useEffect(() => {
    (async () => {
      setLoadingStorage(true);
      await refreshAll();
      setLoadingStorage(false);
    })();
  }, [refreshAll]);

  const [selectedPatternId, setSelectedPatternId] = useState(null);
  const selectedPattern = useMemo(
    () => moPatternClusters.find((p) => p.pattern_id === selectedPatternId) ?? null,
    [moPatternClusters, selectedPatternId]
  );

  const analytics = useMemo(() => {
    if (!analyticsRaw) return { totalComplaints: 0, totalLoss: 0, avgLoss: 0, statesAffected: 0, stateData: [], fraudTypeData: [], monthData: [] };
    const stateData = Object.entries(analyticsRaw.by_state || {})
      .map(([state, complaints]) => ({ state, complaints }))
      .sort((a, b) => b.complaints - a.complaints)
      .slice(0, 10);
    const fraudTypeData = Object.entries(analyticsRaw.by_fraud_type || {})
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
    const byMonth = new Map();
    allComplaints.forEach((c) => {
      const month = (c.date_filed || "").slice(0, 7);
      if (!month) return;
      if (!byMonth.has(month)) byMonth.set(month, { month, complaints: 0, loss: 0 });
      byMonth.get(month).complaints += 1;
      byMonth.get(month).loss += Number(c.amount_lost_inr) || 0;
    });
    const monthData = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
    return {
      totalComplaints: analyticsRaw.total_complaints,
      totalLoss: analyticsRaw.total_loss,
      avgLoss: analyticsRaw.avg_loss,
      statesAffected: analyticsRaw.states_affected,
      stateData, fraudTypeData, monthData,
    };
  }, [analyticsRaw, allComplaints]);

  const complaintRingMap = useMemo(() => {
    const map = new Map();
    rings.forEach((r) => r.member_ids.forEach((id) => map.set(id, r.cluster_id)));
    return map;
  }, [rings]);

  const filteredAllComplaints = useMemo(() => {
    let list = allComplaints;
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((c) =>
        (c.state || "").toLowerCase().includes(q) ||
        (c.phone_used_by_fraudster || "").includes(q) ||
        (c.upi_id || "").toLowerCase().includes(q) ||
        (c.city || "").toLowerCase().includes(q) ||
        (c.complaint_id || "").toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => (b.date_filed || "").localeCompare(a.date_filed || ""));
  }, [allComplaints, query]);

  const selectedAllComplaint = useMemo(
    () => allComplaints.find((c) => c.complaint_id === selectedAllComplaintId) ?? null,
    [allComplaints, selectedAllComplaintId]
  );
  const selectedMule = useMemo(() => {
    const m = muleClusters.find((m) => m.ifsc === selectedMuleIfsc);
    if (!m) return null;
    const byId = new Map(allComplaints.map((c) => [c.complaint_id, c]));
    const complaints = (m.complaint_ids || []).map((id) => {
      const c = byId.get(id);
      return c ? { id: c.complaint_id, state: c.state, city: c.city, victim: c.victim_name, account: c.bank_account, amount: c.amount_lost_inr, date: c.date_filed, fraud_type: c.fraud_type } : null;
    }).filter(Boolean);
    return { ...m, complaints };
  }, [muleClusters, selectedMuleIfsc, allComplaints]);
  const stats = useMemo(() => ({
    total_complaints: allComplaints.length,
    total_links: rings.reduce((s, r) => s + r.size, 0), // complaints involved in a ring
    rings_found: rings.length,
  }), [allComplaints, rings]);

  useEffect(() => {
    if (!selectedRingId && rings.length > 0) setSelectedRingId(rings[0].cluster_id);
  }, [rings, selectedRingId]);

  const selectedRing = useMemo(() => {
    const ringMeta = rings.find((r) => r.cluster_id === selectedRingId);
    if (!ringMeta) return null;
    // Backend sends member_ids only (not full node/edge graph data needed
    // for the visualization) - rebuild that locally from the already-
    // fetched complaint records using the same tested matching logic.
    const memberComplaints = allComplaints.filter((c) => ringMeta.member_ids.includes(c.complaint_id));
    const localClusters = buildCorrelation(memberComplaints);
    const graphData = localClusters[0]; // memberComplaints only contains this one ring, so first (only) cluster
    return { ...ringMeta, nodes: graphData?.nodes || [], edges: graphData?.edges || [] };
  }, [rings, selectedRingId, allComplaints]);
  const selectedNode = useMemo(() => {
    if (!selectedRing || !selectedNodeId) return null;
    return selectedRing.nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [selectedRing, selectedNodeId]);

  useEffect(() => { setSelectedNodeId(null); }, [selectedRingId]);

  const filteredRings = useMemo(() => {
    if (!query.trim()) return rings;
    const q = query.toLowerCase();
    return rings.filter((r) =>
      r.cluster_id.toLowerCase().includes(q) ||
      r.states.some((s) => s.toLowerCase().includes(q)) ||
      r.nodes.some((n) => n.phone.includes(q) || n.upi.toLowerCase().includes(q) || n.city.toLowerCase().includes(q))
    );
  }, [rings, query]);

  const handleNewComplaint = useCallback(async (form) => {
    setSubmitting(true);
    const isEditMode = !!editingComplaint;
    const payload = {
      state: form.state,
      city: form.city,
      victim_name: form.victim_name,
      fraud_type: form.fraud_type,
      phone_used_by_fraudster: form.phone_used_by_fraudster.trim(),
      upi_id: form.upi_id.trim(),
      bank_account: form.bank_account.trim(),
      ifsc_code: form.ifsc_code.trim(),
      amount_lost_inr: Number(form.amount_lost_inr),
      mo_description: form.mo_description || "No description provided.",
    };

    try {
      if (isEditMode) {
        await api.updateComplaint(editingComplaint.complaint_id, payload, authToken);
        setToast({ type: "match", text: "Complaint updated and re-correlated." });
      } else {
        const created = await api.createComplaint(payload, authToken);
        await refreshAll();
        const ringsNow = await api.getRings(authToken);
        const owningRing = ringsNow.find((r) => r.member_ids.includes(created.complaint_id));
        if (owningRing) {
          setSelectedRingId(owningRing.cluster_id);
          setHighlightId(created.complaint_id);
          setToast({ type: "match", text: `Linked to ${owningRing.size - 1} existing complaint(s) in ${owningRing.cluster_id} — ${owningRing.states.join(", ")}` });
        } else {
          setToast({ type: "isolated", text: "No matching identifiers found in existing records. Saved as a standalone complaint." });
        }
        setTimeout(() => setHighlightId(null), 4000);
      }
      await refreshAll();
    } catch (e) {
      setToast({ type: "isolated", text: e.message || "Could not save complaint." });
    }

    setTimeout(() => setToast(null), 6000);
    setSubmitting(false);
    setShowModal(false);
    setEditingComplaint(null);
  }, [editingComplaint, authToken, refreshAll]);

  const handleDeleteComplaint = useCallback(async (complaintId) => {
    try {
      await api.deleteComplaint(complaintId, authToken);
      setSelectedAllComplaintId((id) => (id === complaintId ? null : id));
      setSelectedNodeId((id) => (id === complaintId ? null : id));
      await refreshAll();
      setToast({ type: "isolated", text: `${complaintId} deleted.` });
    } catch (e) {
      setToast({ type: "isolated", text: e.message || "Could not delete complaint." });
    }
    setTimeout(() => setToast(null), 4000);
  }, [authToken, refreshAll]);

  const handleBulkUpload = useCallback(async (validForms) => {
    setBulkUploading(true);
    try {
      const result = await api.bulkUpload(validForms, authToken);
      await refreshAll();
      setToast({ type: "match", text: `${result.created} complaint(s) uploaded and correlated successfully.` });
    } catch (e) {
      setToast({ type: "isolated", text: e.message || "Bulk upload failed." });
    }
    setBulkUploading(false);
    setShowBulkModal(false);
    setTimeout(() => setToast(null), 5000);
  }, [authToken, refreshAll]);

  const handleClearAll = useCallback(async () => {
    setClearing(true);
    try {
      // Delete every complaint currently loaded, one by one via the API.
      // (There's no bulk-delete endpoint by design - deleting real
      // complaint records in bulk isn't something a real system should
      // make too easy. This "Clear All" is mainly useful for testing.)
      for (const c of allComplaints) {
        await api.deleteComplaint(c.complaint_id, authToken).catch(() => {});
      }
      await refreshAll();
    } catch (e) { /* individual deletes already handle their own errors */ }
    setSelectedNodeId(null);
    setSelectedRingId(null);
    setHighlightId(null);
    setClearing(false);
    setShowClearConfirm(false);
    setToast({ type: "isolated", text: "All complaints have been cleared." });
    setTimeout(() => setToast(null), 4000);
  }, [allComplaints, authToken, refreshAll]);

  return (
    <div className="dash-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        html, body, #root {
          height: 100% !important; width: 100% !important; margin: 0 !important;
          padding: 0 !important; max-width: none !important; display: block !important;
          place-items: unset !important; text-align: left !important;
        }
        .dash-root {
          --bg:#0A0E14; --panel:#10151F; --panel-2:#151B26; --border:#232B38;
          --text:#E8EAED; --text-dim:#8A93A3; --text-faint:#5B6577;
          --amber:#D4A544; --red:#E8543F; --teal:#4A9B8E;
          background: var(--bg); color: var(--text); font-family:'Inter',sans-serif;
          height: 100vh; display:flex; flex-direction:column; overflow: hidden;
        }
        .dash-header { display:flex; align-items:center; justify-content:space-between; padding:18px 28px; border-bottom:1px solid var(--border); background:linear-gradient(180deg,#0D121B 0%,#0A0E14 100%); flex-wrap: wrap; gap: 12px; }
        .api-error-banner { display:flex; align-items:center; gap:8px; padding:9px 24px; background:rgba(232,84,63,.1); border-bottom:1px solid rgba(232,84,63,.3); color:#E8543F; font-size:12.5px; }
        .dash-title-block { display:flex; align-items:center; gap:14px; }
        .dash-badge { font-family:'JetBrains Mono',monospace; font-size:10px; letter-spacing:.12em; color:var(--red); border:1px solid rgba(232,84,63,.4); background:rgba(232,84,63,.08); padding:3px 8px; border-radius:3px; }
        .officer-badge { text-align:right; padding-right:20px; border-right:1px solid var(--border); }
        .officer-name { font-size:13px; font-weight:600; color:var(--text); }
        .officer-meta { font-size:10.5px; color:var(--text-faint); margin-top:2px; }
        .dash-title { font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:19px; letter-spacing:-.01em; }
        .dash-subtitle { font-size:12px; color:var(--text-dim); margin-top:2px; }
        .dash-stats { display:flex; gap:24px; align-items:center; }
        .stat-block { text-align:right; }
        .stat-value { font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:600; line-height:1; }
        .stat-label { font-size:10px; color:var(--text-faint); letter-spacing:.08em; text-transform:uppercase; margin-top:4px; }
        .btn-primary { background:var(--teal); color:#06110E; border:none; font-weight:600; font-size:13px; padding:9px 16px; border-radius:6px; cursor:pointer; display:flex; align-items:center; gap:6px; font-family:'Inter',sans-serif; }
        .btn-primary:hover { filter:brightness(1.1); }
        .btn-primary:disabled { opacity:.6; cursor:not-allowed; }
        .btn-secondary { background:transparent; color:var(--text-dim); border:1px solid var(--border); font-size:13px; padding:9px 16px; border-radius:6px; cursor:pointer; font-family:'Inter',sans-serif; }
        .btn-danger { background:transparent; color:var(--red); border:1px solid rgba(232,84,63,.4); font-size:12.5px; padding:9px 14px; border-radius:6px; cursor:pointer; display:flex; align-items:center; gap:6px; font-family:'Inter',sans-serif; }
        .btn-danger:hover { background:rgba(232,84,63,.08); }
        .dash-body { display:flex; flex:1; min-height:0; overflow: hidden; }
        .sidebar { width:320px; border-right:1px solid var(--border); background:var(--panel); display:flex; flex-direction:column; min-height:0; overflow: hidden; }
        .sidebar-search { padding:14px; border-bottom:1px solid var(--border); }
        .view-tabs { display:flex; border-bottom:1px solid var(--border); }
        .view-tab { flex:1; text-align:center; padding:11px 6px; font-size:11.5px; font-weight:600; color:var(--text-faint); cursor:pointer; border-bottom:2px solid transparent; }
        .view-tab.active { color:var(--teal); border-bottom-color:var(--teal); }
        .mule-table-wrap { flex:1; overflow-y:auto; padding:18px 24px; }
        .mule-warning { display:flex; gap:10px; font-size:12px; line-height:1.5; color:var(--text-dim); background:rgba(212,165,68,.06); border:1px solid rgba(212,165,68,.25); border-radius:8px; padding:12px 14px; margin-bottom:16px; }
        .mule-table { width:100%; border-collapse:collapse; font-size:12px; }
        .mule-table th { text-align:left; font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--text-faint); padding:8px 10px; border-bottom:1px solid var(--border); }
        .mule-table td { padding:9px 10px; border-bottom:1px solid var(--border); color:var(--text-dim); }
        .mule-table .mono { font-family:'JetBrains Mono',monospace; color:var(--text); }
        .clickable-row { cursor:pointer; }
        .clickable-row:hover { background:var(--panel); }
        .analytics-summary-item { padding:14px 16px; border-bottom:1px solid var(--border); }
        .analytics-summary-label { font-size:10.5px; color:var(--text-faint); text-transform:uppercase; letter-spacing:.06em; margin-bottom:5px; }
        .analytics-summary-value { font-family:'JetBrains Mono',monospace; font-size:19px; font-weight:600; color:var(--text); }
        .analytics-wrap { flex:1; overflow-y:auto; display:flex; flex-direction:column; }
        .analytics-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; padding:20px 24px; }
        .chart-card { background:var(--panel-2); border:1px solid var(--border); border-radius:10px; padding:16px; }
        .chart-card-title { font-size:12px; font-weight:600; color:var(--text-dim); margin-bottom:8px; }
        .search-box { display:flex; align-items:center; gap:8px; background:var(--panel-2); border:1px solid var(--border); border-radius:6px; padding:8px 10px; }
        .search-box input { background:transparent; border:none; outline:none; color:var(--text); font-size:13px; width:100%; font-family:'Inter',sans-serif; }
        .search-box input::placeholder { color:var(--text-faint); }
        .ring-list { overflow-y:auto; flex:1; }
        .ring-item { padding:13px 16px; border-bottom:1px solid var(--border); cursor:pointer; transition:background .12s ease; }
        .ring-item:hover { background:var(--panel-2); }
        .ring-item.active { background:var(--panel-2); box-shadow: inset 3px 0 0 var(--riskcolor); }
        .ring-item-top { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
        .ring-id { font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--text-dim); }
        .risk-chip { font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.08em; padding:2px 6px; border-radius:3px; font-weight:600; }
        .ring-item-meta { display:flex; align-items:center; gap:10px; font-size:11px; color:var(--text-dim); margin-bottom:6px; }
        .ring-item-states { font-size:11.5px; color:var(--text-faint); line-height:1.4; }
        .ring-item-loss { font-family:'JetBrains Mono',monospace; font-size:13px; font-weight:600; color:var(--text); margin-top:6px; }
        .main-area { flex:1; display:flex; flex-direction:column; min-width:0; min-height:0; overflow:hidden; }
        .main-toolbar { padding:16px 24px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; }
        .toolbar-title { font-family:'Space Grotesk',sans-serif; font-size:16px; font-weight:600; display:flex; align-items:center; gap:10px; }
        .toolbar-sub { font-size:12px; color:var(--text-dim); margin-top:3px; font-family:'JetBrains Mono',monospace; }
        .confidence-pill { font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--teal); border:1px solid rgba(74,155,142,.4); background:rgba(74,155,142,.08); padding:4px 10px; border-radius:4px; }
        .graph-canvas { flex:1; min-height:0; display:flex; align-items:center; justify-content:center; }
        .graph-empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; color:var(--text-faint); font-size:13px; }
        .graph-node { cursor:pointer; }
        .node-label { font-family:'JetBrains Mono',monospace; font-size:9px; pointer-events:none; }
        .pulse-ring { animation: pulse 1.6s ease-out infinite; transform-origin: center; }
        @keyframes pulse { 0% { opacity:1; transform:scale(0.7);} 100% { opacity:0; transform:scale(1.6);} }
        .legend { padding:10px 24px; border-top:1px solid var(--border); display:flex; gap:20px; font-size:11px; color:var(--text-faint); align-items:center; flex-wrap: wrap; }
        .detail-panel { width:340px; border-left:1px solid var(--border); background:var(--panel); overflow-y:auto; padding:20px; }
        .detail-empty { color:var(--text-faint); font-size:13px; padding-top:40px; text-align:center; }
        .detail-section-title { font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-faint); margin:20px 0 10px; font-weight:600; }
        .detail-section-title:first-child { margin-top:0; }
        .field-row { display:flex; align-items:flex-start; gap:9px; padding:7px 0; border-bottom:1px solid var(--border); }
        .field-row svg { flex-shrink:0; margin-top:2px; color:var(--text-faint); }
        .field-label { font-size:10.5px; color:var(--text-faint); }
        .field-value { font-family:'JetBrains Mono',monospace; font-size:12.5px; color:var(--text); word-break:break-all; }
        .mo-text { font-size:12px; line-height:1.55; color:var(--text-dim); background:var(--panel-2); border:1px solid var(--border); border-radius:6px; padding:12px; margin-top:4px; }
        .back-link { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--teal); cursor:pointer; margin-bottom:16px; background:none; border:none; font-family:'Inter',sans-serif; padding:0; }
        .ring-summary-loss { font-family:'JetBrains Mono',monospace; font-size:26px; font-weight:600; color:var(--text); margin-top:4px; }
        .ring-summary-states { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
        .state-tag { font-size:11px; color:var(--text-dim); background:var(--panel-2); border:1px solid var(--border); padding:3px 8px; border-radius:4px; display:flex; align-items:center; gap:4px; }
        .hint-text { font-size:11.5px; color:var(--text-faint); line-height:1.5; margin-top:16px; padding:10px; background:rgba(212,165,68,.06); border:1px solid rgba(212,165,68,.2); border-radius:6px; }

        .modal-overlay { position:fixed; inset:0; background:rgba(4,6,10,.7); backdrop-filter:blur(2px); display:flex; align-items:center; justify-content:center; z-index:50; padding:20px; }
        .modal-box { background:var(--panel); border:1px solid var(--border); border-radius:10px; width:100%; max-width:640px; max-height:90vh; display:flex; flex-direction:column; }
        .modal-header { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid var(--border); }
        .modal-title { font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:15px; display:flex; align-items:center; gap:8px; }
        .icon-btn { background:none; border:none; color:var(--text-dim); cursor:pointer; padding:4px; }
        .modal-body { padding:20px; overflow-y:auto; }
        .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
        .form-field { display:flex; flex-direction:column; gap:5px; }
        .form-field label { font-size:11px; color:var(--text-dim); font-weight:500; }
        .form-field input, .form-field select, .form-field textarea {
          background:var(--panel-2); border:1px solid var(--border); border-radius:6px;
          padding:8px 10px; color:var(--text); font-size:13px; font-family:'Inter',sans-serif; outline:none;
        }
        .form-field input:focus, .form-field select:focus, .form-field textarea:focus { border-color: var(--teal); }
        .form-field textarea { resize:vertical; font-family:'Inter',sans-serif; }
        .err { font-size:10.5px; color:var(--red); }
        .bulk-intro { font-size:12.5px; color:var(--text-dim); line-height:1.5; margin-bottom:14px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
        .template-link { background:none; border:1px solid var(--border); color:var(--teal); font-size:11.5px; padding:6px 10px; border-radius:6px; cursor:pointer; display:flex; align-items:center; white-space:nowrap; font-family:'Inter',sans-serif; }
        .template-link:hover { background:var(--panel-2); }
        .dropzone { border:1.5px dashed var(--border); border-radius:10px; padding:28px; text-align:center; cursor:pointer; transition:border-color .15s; }
        .dropzone:hover { border-color:var(--teal); }
        .bulk-summary { margin-top:14px; font-size:12.5px; }
        .bulk-table-wrap { max-height:260px; overflow-y:auto; margin-top:10px; border:1px solid var(--border); border-radius:8px; }
        .row-action-btn { background:none; border:1px solid var(--border); color:var(--text-dim); padding:5px; border-radius:5px; cursor:pointer; display:flex; align-items:center; justify-content:center; }
        .row-action-btn:hover { background:var(--panel); color:var(--text); }
        .row-action-danger:hover { color:var(--red); border-color:rgba(232,84,63,.5); }
        .modal-footer { display:flex; justify-content:flex-end; gap:10px; padding:16px 20px; border-top:1px solid var(--border); }
        .spin { animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }

        .toast { position:fixed; bottom:24px; right:24px; z-index:60; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px 16px; max-width:340px; display:flex; gap:10px; align-items:flex-start; box-shadow:0 8px 24px rgba(0,0,0,.4); }
        .toast-match { border-color: rgba(212,165,68,.4); }
        .toast-isolated { border-color: rgba(107,122,143,.4); }
        .toast-text { font-size:12.5px; line-height:1.4; color:var(--text-dim); }
      `}</style>

      <header className="dash-header">
        <div className="dash-title-block">
          <Shield size={22} color="#4A9B8E" strokeWidth={1.6} />
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className="dash-title">Cross-State Fraud Correlation Engine</span>
              <span className="dash-badge" style={{ color: "#4A9B8E", borderColor: "rgba(74,155,142,.4)", background: "rgba(74,155,142,.08)" }}>LIVE BACKEND — POSTGRESQL</span>
            </div>
            <div className="dash-subtitle">Link analysis across cybercrime complaint records</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div className="officer-badge">
            <div className="officer-name">{currentUser.name}</div>
            <div className="officer-meta">{currentUser.state} Cyber Cell · Badge {currentUser.badge_id}</div>
          </div>
          <div className="dash-stats">
            <div className="stat-block">
              <div className="stat-value">{stats.total_complaints}</div>
              <div className="stat-label">Complaints</div>
            </div>
            <div className="stat-block">
              <div className="stat-value" style={{ color: "#E8543F" }}>{stats.rings_found}</div>
              <div className="stat-label">Rings Found</div>
            </div>
            <div className="stat-block">
              <div className="stat-value">{stats.total_links}</div>
              <div className="stat-label">In Rings</div>
            </div>
          </div>
          <button className="btn-primary" onClick={() => setShowModal(true)}>
            <Plus size={15} /> New Complaint
          </button>
          <button className="btn-secondary" onClick={() => setShowBulkModal(true)}>
            <FileSpreadsheet size={14} style={{ marginRight: 6 }} /> Bulk Upload
          </button>
          {allComplaints.length > 0 && (
            <button className="btn-danger" onClick={() => setShowClearConfirm(true)}>
              <Trash2 size={14} /> Clear Entered Data ({allComplaints.length})
            </button>
          )}
          <button className="btn-secondary" onClick={onLogout}>
            <LogOut size={13} style={{ marginRight: 6 }} /> Logout
          </button>
        </div>
      </header>

      {apiErrorBanner && (
        <div className="api-error-banner">
          <AlertCircle size={14} /> {apiErrorBanner}
          <button className="template-link" style={{ marginLeft: "auto" }} onClick={refreshAll}>Retry</button>
        </div>
      )}

      <div className="dash-body">
        <aside className="sidebar">
          <div className="view-tabs">
            <div className={"view-tab" + (viewMode === "rings" ? " active" : "")} onClick={() => setViewMode("rings")}>
              Fraud Rings ({rings.length})
            </div>
            <div className={"view-tab" + (viewMode === "mules" ? " active" : "")} onClick={() => setViewMode("mules")}>
              Mule Clusters ({muleClusters.length})
            </div>
            <div className={"view-tab" + (viewMode === "patterns" ? " active" : "")} onClick={() => setViewMode("patterns")}>
              MO Patterns ({moPatternClusters.length})
            </div>
            <div className={"view-tab" + (viewMode === "analytics" ? " active" : "")} onClick={() => setViewMode("analytics")}>
              Analytics
            </div>
            <div className={"view-tab" + (viewMode === "all" ? " active" : "")} onClick={() => setViewMode("all")}>
              All ({stats.total_complaints})
            </div>
          </div>
          {viewMode !== "analytics" && (
            <div className="sidebar-search">
              <div className="search-box">
                <Search size={14} color="#5B6577" />
                <input placeholder="Search state, phone, UPI..." value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </div>
          )}
          {viewMode === "analytics" ? (
            <div className="ring-list">
              <div className="analytics-summary-item">
                <div className="analytics-summary-label">Total Complaints</div>
                <div className="analytics-summary-value">{analytics.totalComplaints}</div>
              </div>
              <div className="analytics-summary-item">
                <div className="analytics-summary-label">Total Reported Loss</div>
                <div className="analytics-summary-value" style={{ color: "#E8543F" }}>{fmtINR(analytics.totalLoss)}</div>
              </div>
              <div className="analytics-summary-item">
                <div className="analytics-summary-label">Average Loss / Complaint</div>
                <div className="analytics-summary-value">{fmtINR(analytics.avgLoss)}</div>
              </div>
              <div className="analytics-summary-item">
                <div className="analytics-summary-label">States Affected</div>
                <div className="analytics-summary-value">{analytics.statesAffected}</div>
              </div>
            </div>
          ) : viewMode === "all" ? (
            <div className="ring-list">
              {filteredAllComplaints.map((c) => {
                const ringId = complaintRingMap.get(c.complaint_id);
                const active = c.complaint_id === selectedAllComplaintId;
                return (
                  <div key={c.complaint_id} className={"ring-item" + (active ? " active" : "")} style={{ "--riskcolor": ringId ? "#E8543F" : "#6B7A8F" }} onClick={() => setSelectedAllComplaintId(c.complaint_id)}>
                    <div className="ring-item-top">
                      <span className="ring-id">{c.complaint_id}</span>
                      {ringId ? (
                        <span className="risk-chip" style={{ color: "#E8543F", background: "rgba(232,84,63,0.15)", border: "1px solid #E8543F55" }}>IN {ringId}</span>
                      ) : (
                        <span className="risk-chip" style={{ color: "#8A93A3", background: "rgba(138,147,163,0.12)", border: "1px solid #8A93A355" }}>ISOLATED</span>
                      )}
                    </div>
                    <div className="ring-item-meta">
                      <span>{c.fraud_type}</span>
                    </div>
                    <div className="ring-item-states">{c.city}, {c.state} · {c.date_filed}</div>
                    <div className="ring-item-loss">{fmtINR(Number(c.amount_lost_inr) || 0)}</div>
                  </div>
                );
              })}
              {filteredAllComplaints.length === 0 && (
                <div style={{ padding: 20, fontSize: 12, color: "#5B6577", textAlign: "center" }}>
                  No complaints match your search.
                </div>
              )}
            </div>
          ) : viewMode === "rings" ? (
            <div className="ring-list">
              {loadingStorage && <div style={{ padding: 16, fontSize: 12, color: "#5B6577" }}>Loading saved complaints...</div>}
              {filteredRings.map((r) => {
                const rs = RISK_STYLES[riskLevel(r)];
                const active = r.cluster_id === selectedRingId;
                return (
                  <div key={r.cluster_id} className={"ring-item" + (active ? " active" : "")} style={{ "--riskcolor": rs.color }} onClick={() => setSelectedRingId(r.cluster_id)}>
                    <div className="ring-item-top">
                      <span className="ring-id">{r.cluster_id}</span>
                      <span className="risk-chip" style={{ color: rs.color, background: rs.glow, border: `1px solid ${rs.color}55` }}>{rs.label}</span>
                    </div>
                    <div className="ring-item-meta">
                      <span>{r.size} complaints</span><span>·</span><span>{Math.round(r.avg_confidence * 100)}% confidence</span>
                    </div>
                    <div className="ring-item-states">{r.states.length > 3 ? r.states.slice(0, 3).join(", ") + ` +${r.states.length - 3} more` : r.states.join(", ")}</div>
                    <div className="ring-item-loss">{fmtINR(r.total_loss)}</div>
                  </div>
                );
              })}
              {rings.length === 0 && !loadingStorage && (
                <div style={{ padding: 20, fontSize: 12, color: "#5B6577", textAlign: "center" }}>
                  No confirmed fraud rings yet. Rings appear once 2+ complaints share an exact phone, UPI, or account match.
                </div>
              )}
            </div>
          ) : viewMode === "mules" ? (
            <div className="ring-list">
              {muleClusters.map((m) => {
                const active = m.ifsc === selectedMuleIfsc;
                const flagColor = m.flag === "SUSPECTED MULE NETWORK" ? "#E8543F" : m.flag === "POSSIBLE MULE NETWORK" ? "#D4A544" : "#8A93A3";
                return (
                  <div key={m.ifsc} className={"ring-item" + (active ? " active" : "")} style={{ "--riskcolor": flagColor }} onClick={() => setSelectedMuleIfsc(m.ifsc)}>
                    <div className="ring-item-top">
                      <span className="ring-id">{m.bank_code} · {m.ifsc}</span>
                      <span className="risk-chip" style={{ color: flagColor, background: `${flagColor}22`, border: `1px solid ${flagColor}55` }}>{m.flag}</span>
                    </div>
                    <div className="ring-item-meta">
                      <span>{m.distinct_accounts} distinct accounts</span><span>·</span><span>{m.complaint_count} complaints</span>
                    </div>
                    <div className="ring-item-states">{m.states.length > 3 ? m.states.slice(0, 3).join(", ") + ` +${m.states.length - 3} more` : m.states.join(", ")}</div>
                    <div className="ring-item-loss">{fmtINR(m.total_loss)}</div>
                  </div>
                );
              })}
              {muleClusters.length === 0 && (
                <div style={{ padding: 20, fontSize: 12, color: "#5B6577", textAlign: "center" }}>
                  No suspected mule clusters yet. A branch is flagged once 3+ different account numbers at the same IFSC appear across separate complaints.
                </div>
              )}
            </div>
          ) : (
            <div className="ring-list">
              {moPatternClusters.map((p) => {
                const active = p.pattern_id === selectedPatternId;
                return (
                  <div key={p.pattern_id} className={"ring-item" + (active ? " active" : "")} style={{ "--riskcolor": "#9B7EDE" }} onClick={() => setSelectedPatternId(p.pattern_id)}>
                    <div className="ring-item-top">
                      <span className="ring-id">{p.pattern_id}</span>
                      <span className="risk-chip" style={{ color: "#9B7EDE", background: "rgba(155,126,222,0.18)", border: "1px solid #9B7EDE55" }}>{Math.round(p.avg_similarity * 100)}% MATCH</span>
                    </div>
                    <div className="ring-item-meta">
                      <span>{p.size} complaints</span><span>·</span><span>no shared identifiers</span>
                    </div>
                    <div className="ring-item-states">{p.states.length > 3 ? p.states.slice(0, 3).join(", ") + ` +${p.states.length - 3} more` : p.states.join(", ")}</div>
                    <div className="ring-item-loss">{fmtINR(p.total_loss)}</div>
                  </div>
                );
              })}
              {moPatternClusters.length === 0 && (
                <div style={{ padding: 20, fontSize: 12, color: "#5B6577", textAlign: "center" }}>
                  No text-pattern matches yet. This checks for near-identical scam descriptions even when phone/UPI/account are all different.
                </div>
              )}
            </div>
          )}
        </aside>

        <main className="main-area">
          {viewMode === "analytics" ? (
            <div className="analytics-wrap">
              <div className="main-toolbar">
                <div>
                  <div className="toolbar-title">
                    <BarChart3 size={16} color="#4A9B8E" />
                    Complaint Analytics
                  </div>
                  <div className="toolbar-sub">Aggregated view across all {analytics.totalComplaints} complaints on record</div>
                </div>
              </div>
              <div className="analytics-grid">
                <div className="chart-card">
                  <div className="chart-card-title">Complaints by State (Top 10)</div>
                  {analytics.stateData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={240}>
                      <BarChart data={analytics.stateData} layout="vertical" margin={{ left: 10, right: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#232B38" horizontal={false} />
                        <XAxis type="number" tick={{ fill: "#8A93A3", fontSize: 10 }} stroke="#232B38" />
                        <YAxis type="category" dataKey="state" width={90} tick={{ fill: "#8A93A3", fontSize: 10.5 }} stroke="#232B38" />
                        <Tooltip contentStyle={{ background: "#151B26", border: "1px solid #232B38", borderRadius: 6, fontSize: 12 }} labelStyle={{ color: "#E8EAED" }} />
                        <Bar dataKey="complaints" fill="#4A9B8E" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : <EmptyChartNote />}
                </div>

                <div className="chart-card">
                  <div className="chart-card-title">Fraud Type Breakdown</div>
                  {analytics.fraudTypeData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={240}>
                      <PieChart>
                        <Pie data={analytics.fraudTypeData} dataKey="count" nameKey="type" cx="50%" cy="50%" outerRadius={80} label={({ percent }) => `${(percent * 100).toFixed(0)}%`} labelLine={false}>
                          {analytics.fraudTypeData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                        </Pie>
                        <Tooltip contentStyle={{ background: "#151B26", border: "1px solid #232B38", borderRadius: 6, fontSize: 12 }} labelStyle={{ color: "#E8EAED" }} />
                        <Legend wrapperStyle={{ fontSize: 10.5, color: "#8A93A3" }} />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : <EmptyChartNote />}
                </div>

                <div className="chart-card" style={{ gridColumn: "1 / -1" }}>
                  <div className="chart-card-title">Complaints & Loss Over Time (by Month)</div>
                  {analytics.monthData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={220}>
                      <LineChart data={analytics.monthData} margin={{ left: 0, right: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#232B38" />
                        <XAxis dataKey="month" tick={{ fill: "#8A93A3", fontSize: 10.5 }} stroke="#232B38" />
                        <YAxis yAxisId="left" tick={{ fill: "#8A93A3", fontSize: 10 }} stroke="#232B38" />
                        <YAxis yAxisId="right" orientation="right" tick={{ fill: "#8A93A3", fontSize: 10 }} stroke="#232B38" tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} />
                        <Tooltip contentStyle={{ background: "#151B26", border: "1px solid #232B38", borderRadius: 6, fontSize: 12 }} labelStyle={{ color: "#E8EAED" }} formatter={(v, name) => name === "loss" ? [fmtINR(v), "Loss"] : [v, "Complaints"]} />
                        <Legend wrapperStyle={{ fontSize: 10.5, color: "#8A93A3" }} />
                        <Line yAxisId="left" type="monotone" dataKey="complaints" stroke="#4A9B8E" strokeWidth={2} dot={{ r: 3 }} name="complaints" />
                        <Line yAxisId="right" type="monotone" dataKey="loss" stroke="#D4A544" strokeWidth={2} dot={{ r: 3 }} name="loss" />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : <EmptyChartNote />}
                </div>
              </div>
            </div>
          ) : viewMode === "all" ? (
            <div className="mule-table-wrap" style={{ flex: 1 }}>
              <div className="main-toolbar" style={{ padding: "0 0 16px 0", border: "none" }}>
                <div>
                  <div className="toolbar-title">
                    <Shield size={16} color="#4A9B8E" />
                    All Complaints
                  </div>
                  <div className="toolbar-sub">{filteredAllComplaints.length} record(s) · click a row to view full detail</div>
                </div>
              </div>
              <table className="mule-table">
                <thead>
                  <tr><th>ID</th><th>Date</th><th>State / City</th><th>Fraud Type</th><th>Amount</th><th>Status</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {filteredAllComplaints.map((c) => {
                    const ringId = complaintRingMap.get(c.complaint_id);
                    return (
                      <tr key={c.complaint_id} className="clickable-row" onClick={() => setSelectedAllComplaintId(c.complaint_id)}>
                        <td className="mono">{c.complaint_id}</td>
                        <td className="mono">{c.date_filed}</td>
                        <td>{c.city}, {c.state}</td>
                        <td>{c.fraud_type}</td>
                        <td className="mono">{fmtINR(Number(c.amount_lost_inr) || 0)}</td>
                        <td>{ringId ? <span style={{ color: "#E8543F" }}>In {ringId}</span> : <span style={{ color: "#6B7A8F" }}>Isolated</span>}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button className="row-action-btn" title="Edit" onClick={() => { setEditingComplaint(c); setShowModal(true); }}>
                              <CheckCircle2 size={13} />
                            </button>
                            <button className="row-action-btn row-action-danger" title="Delete" onClick={() => setConfirmDeleteId(c.complaint_id)}>
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : viewMode === "rings" ? (
            <>
              <div className="main-toolbar">
                <div>
                  <div className="toolbar-title">
                    <AlertTriangle size={16} color={selectedRing ? RISK_STYLES[riskLevel(selectedRing)].color : "#5B6577"} />
                    {selectedRing ? selectedRing.cluster_id : "No cluster selected"}
                  </div>
                  {selectedRing && <div className="toolbar-sub">{selectedRing.size} linked complaints · {selectedRing.states.join(" → ")}</div>}
                </div>
                {selectedRing && <div className="confidence-pill">{Math.round(selectedRing.avg_confidence * 100)}% avg link confidence</div>}
              </div>
              <RingGraph ring={selectedRing} onSelectNode={setSelectedNodeId} selectedNodeId={selectedNodeId} highlightId={highlightId} />
              <div className="legend">
                <div>Edge = shared identifier (phone / UPI / account)</div>
                <div>Thicker line = higher confidence</div>
                <div>Click a node to view complaint detail →</div>
              </div>
            </>
          ) : (
            <>
              <div className="main-toolbar">
                <div>
                  <div className="toolbar-title">
                    <AlertTriangle size={16} color={selectedMule ? (selectedMule.flag === "SUSPECTED MULE NETWORK" ? "#E8543F" : "#D4A544") : "#5B6577"} />
                    {selectedMule ? `${selectedMule.bank_code} branch — ${selectedMule.ifsc}` : "No branch selected"}
                  </div>
                  {selectedMule && <div className="toolbar-sub">{selectedMule.distinct_accounts} distinct accounts · {selectedMule.complaint_count} complaints</div>}
                </div>
                {selectedMule && (
                  <div className="confidence-pill" style={{ color: selectedMule.flag === "SUSPECTED MULE NETWORK" ? "#E8543F" : "#D4A544", borderColor: selectedMule.flag === "SUSPECTED MULE NETWORK" ? "#E8543F66" : "#D4A54466", background: selectedMule.flag === "SUSPECTED MULE NETWORK" ? "rgba(232,84,63,.08)" : "rgba(212,165,68,.08)" }}>
                    🚩 {selectedMule.flag}
                  </div>
                )}
              </div>
              {selectedMule ? (
                <div className="mule-table-wrap">
                  <div className="mule-warning">
                    <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                    <div>
                      <b>Evidence supporting this flag:</b>
                      <ul style={{ margin: "6px 0 0 0", paddingLeft: 18 }}>
                        {selectedMule.evidence.map((e, i) => <li key={i} style={{ marginBottom: 4 }}>{e}</li>)}
                      </ul>
                      <div style={{ marginTop: 8, color: "#8A93A3" }}>
                        This is a pattern flag based on complaint data only — it does not confirm a mule network on
                        its own. Confirming actual money movement requires the bank's transaction records, obtainable
                        only through a formal legal request.
                      </div>
                    </div>
                  </div>
                  <table className="mule-table">
                    <thead>
                      <tr><th>Complaint</th><th>Account No.</th><th>State / City</th><th>Fraud Type</th><th>Amount</th></tr>
                    </thead>
                    <tbody>
                      {selectedMule.complaints.map((c) => (
                        <tr key={c.id}>
                          <td className="mono">{c.id}</td>
                          <td className="mono">{c.account}</td>
                          <td>{c.city}, {c.state}</td>
                          <td>{c.fraud_type}</td>
                          <td className="mono">{fmtINR(Number(c.amount))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="graph-empty">
                  <Shield size={40} strokeWidth={1.2} />
                  <p>Select a branch cluster to review its accounts</p>
                </div>
              )}
              <div className="legend">
                <div>Grouped by shared bank branch (IFSC), with different account numbers</div>
                <div>Proxy signal only — confirm via legal request to the bank before acting</div>
              </div>
            </>
          )}
        </main>

        <aside className="detail-panel">
          {viewMode === "all" && selectedAllComplaint ? (
            <>
              <button className="back-link" onClick={() => setSelectedAllComplaintId(null)}><ArrowLeft size={13} /> Back to list</button>
              <div className="detail-section-title">Complaint Record</div>
              <div className="field-row"><Shield size={13} /><div><div className="field-label">Complaint ID</div><div className="field-value">{selectedAllComplaint.complaint_id}</div></div></div>
              <div className="field-row"><MapPin size={13} /><div><div className="field-label">Filed at</div><div className="field-value">{selectedAllComplaint.city}, {selectedAllComplaint.state} — {selectedAllComplaint.date_filed}</div></div></div>
              <div className="field-row"><Shield size={13} /><div><div className="field-label">Victim name</div><div className="field-value">{selectedAllComplaint.victim_name}</div></div></div>
              <div className="field-row"><AlertTriangle size={13} /><div><div className="field-label">Fraud type</div><div className="field-value">{selectedAllComplaint.fraud_type}</div></div></div>
              <div className="field-row"><IndianRupee size={13} /><div><div className="field-label">Amount lost</div><div className="field-value">{fmtINR(Number(selectedAllComplaint.amount_lost_inr) || 0)}</div></div></div>
              <div className="detail-section-title">Identifiers Reported</div>
              <div className="field-row"><Phone size={13} /><div><div className="field-label">Fraudster phone</div><div className="field-value">{selectedAllComplaint.phone_used_by_fraudster || "—"}</div></div></div>
              <div className="field-row"><CreditCard size={13} /><div><div className="field-label">UPI ID</div><div className="field-value">{selectedAllComplaint.upi_id || "—"}</div></div></div>
              <div className="field-row"><CreditCard size={13} /><div><div className="field-label">Bank account</div><div className="field-value">{selectedAllComplaint.bank_account || "—"}</div></div></div>
              <div className="field-row"><CreditCard size={13} /><div><div className="field-label">IFSC</div><div className="field-value">{selectedAllComplaint.ifsc_code || "—"}</div></div></div>
              <div className="detail-section-title">Modus Operandi</div>
              <div className="mo-text">{selectedAllComplaint.mo_description}</div>
              {complaintRingMap.get(selectedAllComplaint.complaint_id) ? (
                <div className="hint-text" style={{ background: "rgba(232,84,63,.06)", borderColor: "rgba(232,84,63,.2)" }}>
                  This complaint is linked to <b>{complaintRingMap.get(selectedAllComplaint.complaint_id)}</b> — switch to the "Fraud Rings" tab to see the full connected network.
                </div>
              ) : (
                <div className="hint-text">
                  No matching identifiers found in any other complaint yet — currently an isolated record.
                </div>
              )}
              {selectedAllComplaint.submitted_by_name && (
                <div className="hint-text">
                  Submitted by <b>{selectedAllComplaint.submitted_by_name}</b> ({selectedAllComplaint.submitted_by_state} Cyber Cell)
                  {selectedAllComplaint.last_edited_by && (
                    <> · last edited by <b>{selectedAllComplaint.last_edited_by}</b></>
                  )}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button
                  className="btn-secondary"
                  style={{ flex: 1 }}
                  onClick={() => { setEditingComplaint(selectedAllComplaint); setShowModal(true); }}
                >
                  Edit
                </button>
                <button
                  className="btn-danger"
                  style={{ flex: 1, justifyContent: "center" }}
                  onClick={() => setConfirmDeleteId(selectedAllComplaint.complaint_id)}
                >
                  <Trash2 size={13} style={{ marginRight: 6 }} /> Delete
                </button>
              </div>
            </>
          ) : selectedNode ? (
            <>
              <button className="back-link" onClick={() => setSelectedNodeId(null)}><ArrowLeft size={13} /> Back to ring summary</button>
              <div className="detail-section-title">Complaint Record</div>
              <div className="field-row"><Shield size={13} /><div><div className="field-label">Complaint ID</div><div className="field-value">{selectedNode.id}</div></div></div>
              <div className="field-row"><MapPin size={13} /><div><div className="field-label">Filed at</div><div className="field-value">{selectedNode.city}, {selectedNode.state} — {selectedNode.date}</div></div></div>
              <div className="field-row"><AlertTriangle size={13} /><div><div className="field-label">Fraud type</div><div className="field-value">{selectedNode.fraud_type}</div></div></div>
              <div className="field-row"><IndianRupee size={13} /><div><div className="field-label">Amount lost</div><div className="field-value">{fmtINR(selectedNode.amount)}</div></div></div>
              <div className="detail-section-title">Shared Identifiers</div>
              <div className="field-row"><Phone size={13} /><div><div className="field-label">Phone used by fraudster</div><div className="field-value">{selectedNode.phone || "—"}</div></div></div>
              <div className="field-row"><CreditCard size={13} /><div><div className="field-label">UPI ID</div><div className="field-value">{selectedNode.upi || "—"}</div></div></div>
              <div className="field-row"><CreditCard size={13} /><div><div className="field-label">Bank account</div><div className="field-value">{selectedNode.account || "—"}</div></div></div>
              <div className="field-row"><CreditCard size={13} /><div><div className="field-label">IFSC</div><div className="field-value">{selectedNode.ifsc || "—"}</div></div></div>
              <div className="detail-section-title">Modus Operandi</div>
              <div className="mo-text">{selectedNode.mo}</div>
              <div className="hint-text">To confirm the real identity behind this UPI ID or account, the investigating officer must request KYC records from the bank / NPCI through a formal legal notice (e.g. CrPC Sec. 91) — this tool only flags the correlation, it does not access bank data.</div>
            </>
          ) : selectedRing ? (
            <>
              <div className="detail-section-title">Ring Summary</div>
              <div className="ring-summary-loss">{fmtINR(selectedRing.total_loss)}</div>
              <div className="field-label" style={{ marginTop: 2 }}>total reported loss across cluster</div>
              <div className="ring-summary-states">{selectedRing.states.map((s) => <span className="state-tag" key={s}><MapPin size={10} /> {s}</span>)}</div>
              <div className="detail-section-title">Cluster Stats</div>
              <div className="field-row"><Shield size={13} /><div><div className="field-label">Complaints in ring</div><div className="field-value">{selectedRing.size}</div></div></div>
              <div className="field-row"><AlertTriangle size={13} /><div><div className="field-label">Avg link confidence</div><div className="field-value">{Math.round(selectedRing.avg_confidence * 100)}%</div></div></div>
              <div className="field-row"><MapPin size={13} /><div><div className="field-label">Cross-state spread</div><div className="field-value">{selectedRing.cross_state ? "Yes" : "No"}</div></div></div>
              <div className="hint-text">Click any node in the graph to open its full complaint record, shared identifiers, and modus operandi.</div>
            </>
          ) : (
            <div className="detail-empty">Select a case cluster from the left to begin.</div>
          )}
        </aside>
      </div>

      {showModal && (
        <NewComplaintModal
          onClose={() => { setShowModal(false); setEditingComplaint(null); }}
          onSubmit={handleNewComplaint}
          submitting={submitting}
          initialData={editingComplaint}
          isEdit={!!editingComplaint}
        />
      )}
      {showBulkModal && <BulkUploadModal onClose={() => setShowBulkModal(false)} onConfirm={handleBulkUpload} uploading={bulkUploading} />}

      {confirmDeleteId && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteId(null)}>
          <div className="modal-box" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title"><Trash2 size={16} color="#E8543F" /> Delete Complaint</div>
              <button className="icon-btn" onClick={() => setConfirmDeleteId(null)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: "#8A93A3", lineHeight: 1.6 }}>
                This will permanently delete complaint <b>{confirmDeleteId}</b>. This cannot be undone, and any
                fraud ring, mule cluster, or pattern it was part of will be recalculated without it.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
              <button
                className="btn-primary"
                style={{ background: "#E8543F", color: "white" }}
                onClick={() => { handleDeleteComplaint(confirmDeleteId); setConfirmDeleteId(null); }}
              >
                Yes, delete
              </button>
            </div>
          </div>
        </div>
      )}

      {showClearConfirm && (
        <div className="modal-overlay" onClick={() => setShowClearConfirm(false)}>
          <div className="modal-box" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title"><Trash2 size={16} color="#E8543F" /> Clear Entered Data</div>
              <button className="icon-btn" onClick={() => setShowClearConfirm(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: "#8A93A3", lineHeight: 1.6 }}>
                This will permanently delete all {allComplaints.length} complaint(s) you entered through
                the "+ New Complaint" form. This cannot be undone. The base demo dataset is not affected by
                this action.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowClearConfirm(false)}>Cancel</button>
              <button className="btn-primary" style={{ background: "#E8543F", color: "white" }} onClick={handleClearAll} disabled={clearing}>
                {clearing ? <><Loader2 size={14} className="spin" /> Clearing...</> : "Yes, clear all"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={"toast " + (toast.type === "match" ? "toast-match" : "toast-isolated")}>
          {toast.type === "match" ? <CheckCircle2 size={16} color="#D4A544" /> : <AlertCircle size={16} color="#8A93A3" />}
          <div className="toast-text">{toast.text}</div>
        </div>
      )}
    </div>
  );
}

// =======================================================================
// AUTHENTICATION LAYER
// -----------------------------------------------------------------------
// IMPORTANT (read before deploying this for real use):
// This authentication is CLIENT-SIDE ONLY. Passwords are hashed with
// SHA-256 before being stored (never in plain text), which is better
// than nothing, but this is still NOT equivalent to real server-side
// authentication. A determined user with browser dev tools could still
// inspect stored data. For real deployment, this entire auth layer must
// be replaced with a proper backend (server-side password hashing with
// bcrypt/argon2, HTTPS-only cookies or JWTs, rate limiting on login
// attempts, etc). Treat this as a working simulation of the *flow*,
// not a production-grade security implementation.
// =======================================================================

// Registration codes are decided and distributed by the coordinating
// cybercrime authority BEFORE rollout, one per state. They only prove
// "this person is affiliated with an authorized state cyber cell" at
// signup time - they are never used for day-to-day login, so leaking
// one only lets someone attempt to REGISTER (still needs a real name +
// badge ID, which is auditable), not silently access existing accounts.
const STATE_REGISTRATION_CODES = {
  "Andhra Pradesh": "AP-CYBER-2026",
  "Bihar": "BR-CYBER-2026",
  "Delhi": "DL-CYBER-2026",
  "Gujarat": "GJ-CYBER-2026",
  "Karnataka": "KA-CYBER-2026",
  "Madhya Pradesh": "MP-CYBER-2026",
  "Maharashtra": "MH-CYBER-2026",
  "Rajasthan": "RJ-CYBER-2026",
  "Tamil Nadu": "TN-CYBER-2026",
  "Telangana": "TS-CYBER-2026",
  "Uttar Pradesh": "UP-CYBER-2026",
  "West Bengal": "WB-CYBER-2026",
};
// NOTE: these placeholder codes must be changed before any real rollout,
// and should be distributed to each state's cyber cell through a secure,
// offline channel - not hardcoded in public source code like this. This
// is here only to demonstrate the intended signup flow.

// ---------------------------------------------------------------------
// STORAGE ABSTRACTION
// -----------------------------------------------------------------------
// window.storage only exists inside Claude's artifact preview sandbox.
// When this app runs as a real standalone site (localhost, Vercel, etc.),
// window.storage does not exist, so we fall back to the browser's own
// localStorage. This makes the exact same code work in both places.
// NOTE: localStorage is per-browser/per-device only - it does NOT sync
// data between different officers' computers. Real multi-user deployment
// still needs a proper backend database (see Phase 1 of the roadmap).
// ---------------------------------------------------------------------
const appStorage = {
  async get(key, shared) {
    if (typeof window !== "undefined" && window.storage) {
      return window.storage.get(key, shared);
    }
    const raw = localStorage.getItem(key);
    if (raw === null) throw new Error("not found");
    return { key, value: raw, shared };
  },
  async set(key, value, shared) {
    if (typeof window !== "undefined" && window.storage) {
      return window.storage.set(key, value, shared);
    }
    localStorage.setItem(key, value);
    return { key, value, shared };
  },
  async delete(key, shared) {
    if (typeof window !== "undefined" && window.storage) {
      return window.storage.delete(key, shared);
    }
    localStorage.removeItem(key);
    return { key, deleted: true, shared };
  },
  async list(prefix, shared) {
    if (typeof window !== "undefined" && window.storage) {
      return window.storage.list(prefix, shared);
    }
    const keys = Object.keys(localStorage).filter((k) => !prefix || k.startsWith(prefix));
    return { keys, prefix, shared };
  },
};

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function EmptyChartNote() {
  return (
    <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: "#5B6577", fontSize: 12 }}>
      Not enough data yet — add complaints to see this chart.
    </div>
  );
}

function EmptyState({ icon: Icon, title, sub }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, color: "#5B6577" }}>
      <Icon size={30} strokeWidth={1.3} />
      <div style={{ fontSize: 13 }}>{title}</div>
      {sub && <div style={{ fontSize: 11 }}>{sub}</div>}
    </div>
  );
}

function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [loginForm, setLoginForm] = useState({ email: "", password: "" });

  const [signupForm, setSignupForm] = useState({
    name: "", badgeId: "", state: "", regCode: "",
    email: "", password: "", confirmPassword: "",
  });

  const handleLogin = async () => {
    setError("");
    if (!loginForm.email.trim() || !loginForm.password) {
      setError("Enter both email and password.");
      return;
    }
    setBusy(true);
    try {
      const result = await api.login({
        email: loginForm.email.trim().toLowerCase(),
        password: loginForm.password,
      });
      onLogin(result.user, result.token);
    } catch (e) {
      setError(e.status === 0 ? e.message : (e.message || "Login failed. Try again."));
    }
    setBusy(false);
  };

  const handleSignup = async () => {
    setError("");
    const f = signupForm;
    if (!f.name.trim() || !f.badgeId.trim() || !f.state || !f.email.trim() || !f.password) {
      setError("Please fill all required fields.");
      return;
    }
    if (f.password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (f.password !== f.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const result = await api.signup({
        name: f.name.trim(),
        badge_id: f.badgeId.trim(),
        state: f.state,
        reg_code: f.regCode.trim(),
        email: f.email.trim().toLowerCase(),
        password: f.password,
      });
      onLogin(result.user, result.token);
    } catch (e) {
      setError(e.status === 0 ? e.message : (e.message || "Signup failed. Try again."));
    }
    setBusy(false);
  };

  return (
    <div className="auth-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        html, body, #root {
          height: 100% !important; width: 100% !important; margin: 0 !important;
          padding: 0 !important; max-width: none !important; display: block !important;
          place-items: unset !important; text-align: left !important;
        }
        .auth-root {
          --bg:#0A0E14; --panel:#10151F; --panel-2:#151B26; --border:#232B38;
          --text:#E8EAED; --text-dim:#8A93A3; --text-faint:#5B6577; --teal:#4A9B8E; --red:#E8543F;
          height: 100vh; background: var(--bg); color: var(--text); font-family:'Inter',sans-serif;
          display:flex; align-items:center; justify-content:center; padding: 20px;
        }
        .auth-card { width:100%; max-width:440px; background:var(--panel); border:1px solid var(--border); border-radius:12px; padding: 32px; }
        .auth-header { display:flex; flex-direction:column; align-items:center; text-align:center; margin-bottom: 22px; }
        .auth-title { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:19px; margin-top:12px; }
        .auth-sub { font-size:12px; color:var(--text-dim); margin-top:4px; }
        .auth-tabs { display:flex; background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:3px; margin-bottom:20px; }
        .auth-tab { flex:1; text-align:center; padding:8px; font-size:12.5px; border-radius:6px; cursor:pointer; color:var(--text-dim); font-weight:500; }
        .auth-tab.active { background:var(--teal); color:#06110E; font-weight:600; }
        .auth-field { margin-bottom: 13px; }
        .auth-field label { font-size:11px; color:var(--text-dim); font-weight:500; display:block; margin-bottom:5px; }
        .auth-field input, .auth-field select { width:100%; background:var(--panel-2); border:1px solid var(--border); border-radius:6px; padding:9px 11px; color:var(--text); font-size:13px; outline:none; font-family:'Inter',sans-serif; }
        .auth-field input:focus, .auth-field select:focus { border-color: var(--teal); }
        .pw-wrap { position: relative; }
        .pw-toggle { position:absolute; right:10px; top:50%; transform:translateY(-50%); background:none; border:none; color:var(--text-faint); cursor:pointer; padding:2px; }
        .auth-row { display:flex; gap:10px; }
        .auth-row > div { flex:1; }
        .auth-btn { width:100%; background:var(--teal); color:#06110E; border:none; font-weight:600; font-size:14px; padding:11px; border-radius:7px; cursor:pointer; margin-top: 6px; display:flex; align-items:center; justify-content:center; gap:8px; }
        .auth-btn:disabled { opacity:.6; cursor:not-allowed; }
        .auth-error { background:rgba(232,84,63,.08); border:1px solid rgba(232,84,63,.3); color:#E8543F; font-size:12px; padding:9px 11px; border-radius:6px; margin-bottom:14px; line-height:1.4; }
        .auth-note { font-size:10.5px; color:var(--text-faint); line-height:1.5; margin-top:18px; padding:10px; background:rgba(212,165,68,.06); border:1px solid rgba(212,165,68,.2); border-radius:6px; }
        .spin { animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      <div className="auth-card">
        <div className="auth-header">
          <Shield size={30} color="#4A9B8E" strokeWidth={1.5} />
          <div className="auth-title">Cross-State Fraud Correlation Engine</div>
          <div className="auth-sub">Authorized cybercrime cell access only</div>
        </div>

        <div className="auth-tabs">
          <div className={"auth-tab" + (mode === "login" ? " active" : "")} onClick={() => { setMode("login"); setError(""); }}>Log In</div>
          <div className={"auth-tab" + (mode === "signup" ? " active" : "")} onClick={() => { setMode("signup"); setError(""); }}>Officer Sign Up</div>
        </div>

        {error && <div className="auth-error"><AlertCircle size={12} style={{ display: "inline", marginRight: 5 }} />{error}</div>}

        {mode === "login" ? (
          <>
            <div className="auth-field">
              <label>Official email</label>
              <input type="email" value={loginForm.email} onChange={(e) => setLoginForm((f) => ({ ...f, email: e.target.value }))} placeholder="officer@cybercell.gov.in" />
            </div>
            <div className="auth-field">
              <label>Password</label>
              <div className="pw-wrap">
                <input type={showPw ? "text" : "password"} value={loginForm.password} onChange={(e) => setLoginForm((f) => ({ ...f, password: e.target.value }))} placeholder="••••••••" />
                <button className="pw-toggle" onClick={() => setShowPw((s) => !s)}>{showPw ? <EyeOff size={15} /> : <Eye size={15} />}</button>
              </div>
            </div>
            <button className="auth-btn" onClick={handleLogin} disabled={busy}>
              {busy ? <><Loader2 size={15} className="spin" /> Signing in...</> : <><Lock size={15} /> Log In</>}
            </button>
          </>
        ) : (
          <>
            <div className="auth-field">
              <label>Full name</label>
              <input value={signupForm.name} onChange={(e) => setSignupForm((f) => ({ ...f, name: e.target.value }))} placeholder="Officer full name" />
            </div>
            <div className="auth-row">
              <div className="auth-field">
                <label>Badge / Employee ID</label>
                <input value={signupForm.badgeId} onChange={(e) => setSignupForm((f) => ({ ...f, badgeId: e.target.value }))} placeholder="e.g. GJ-4821" />
              </div>
              <div className="auth-field">
                <label>State cyber cell</label>
                <select value={signupForm.state} onChange={(e) => setSignupForm((f) => ({ ...f, state: e.target.value }))}>
                  <option value="">Select state</option>
                  {Object.keys(STATE_REGISTRATION_CODES).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div className="auth-field">
              <label>State registration code</label>
              <input value={signupForm.regCode} onChange={(e) => setSignupForm((f) => ({ ...f, regCode: e.target.value }))} placeholder="Issued by your coordinating authority" />
            </div>
            <div className="auth-field">
              <label>Official email</label>
              <input type="email" value={signupForm.email} onChange={(e) => setSignupForm((f) => ({ ...f, email: e.target.value }))} placeholder="officer@cybercell.gov.in" />
            </div>
            <div className="auth-row">
              <div className="auth-field">
                <label>Password (min. 8 characters)</label>
                <input type={showPw ? "text" : "password"} value={signupForm.password} onChange={(e) => setSignupForm((f) => ({ ...f, password: e.target.value }))} placeholder="••••••••" />
              </div>
              <div className="auth-field">
                <label>Confirm password</label>
                <input type={showPw ? "text" : "password"} value={signupForm.confirmPassword} onChange={(e) => setSignupForm((f) => ({ ...f, confirmPassword: e.target.value }))} placeholder="••••••••" />
              </div>
            </div>
            <button className="auth-btn" onClick={handleSignup} disabled={busy}>
              {busy ? <><Loader2 size={15} className="spin" /> Creating account...</> : <><UserPlus size={15} /> Create Officer Account</>}
            </button>
          </>
        )}

        <div className="auth-note">
          <KeyRound size={11} style={{ display: "inline", marginRight: 4 }} />
          The state registration code is issued once by the coordinating cybercrime authority and shared
          through a secure offline channel with each state cell. It only authorizes new account creation -
          every officer still logs in with their own individual email and password, which keeps every action
          in the system attributable to a specific person.
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [authToken, setAuthToken] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);

  // Session persistence: a JWT + user object saved in the browser's
  // localStorage so refreshing the page doesn't log you out. This is
  // safe here because this is a real, standalone deployed web app
  // (not the Claude artifact sandbox, which disallows localStorage).
  useEffect(() => {
    try {
      const saved = localStorage.getItem("fraud_app_session");
      if (saved) {
        const { user, token } = JSON.parse(saved);
        setCurrentUser(user);
        setAuthToken(token);
      }
    } catch (e) { /* no valid saved session */ }
    setCheckingSession(false);
  }, []);

  const handleLogin = (user, token) => {
    setCurrentUser(user);
    setAuthToken(token);
    try { localStorage.setItem("fraud_app_session", JSON.stringify({ user, token })); } catch (e) {}
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setAuthToken(null);
    try { localStorage.removeItem("fraud_app_session"); } catch (e) {}
  };

  if (checkingSession) {
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0A0E14", color: "#5B6577" }}>
        <Loader2 size={20} className="spin" />
      </div>
    );
  }

  if (!currentUser) {
    return <AuthScreen onLogin={handleLogin} />;
  }

  return <Dashboard currentUser={currentUser} authToken={authToken} onLogout={handleLogout} />;
}
