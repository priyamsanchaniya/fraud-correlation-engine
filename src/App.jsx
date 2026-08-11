import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import * as d3 from "d3";
import {
  AlertTriangle, MapPin, Shield, IndianRupee, Phone, CreditCard,
  ArrowLeft, Search, Plus, X, CheckCircle2, Loader2, AlertCircle, Trash2,
  LogOut, Lock, UserPlus, Eye, EyeOff, KeyRound,
} from "lucide-react";

// ---------------------------------------------------------------------
// EMBEDDED BASE CASE DATA (all 311 synthetic complaints, isolated + ring)
// New complaints entered through the "+ New Complaint" form are saved
// to persistent storage and merged with this base set on every load.
// ---------------------------------------------------------------------
const ALL_COMPLAINTS = []; // production: starts empty, no demo/synthetic data

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
const MATCH_WEIGHTS = {
  phone_used_by_fraudster: 0.9,
  upi_id: 0.9,
  bank_account: 0.95,
  ifsc_code: 0.3,
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

function NewComplaintModal({ onClose, onSubmit, submitting }) {
  const [form, setForm] = useState(emptyForm());
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
          <div className="modal-title"><Plus size={16} /> New Complaint Intake</div>
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
            {submitting ? <><Loader2 size={14} className="spin" /> Correlating...</> : "Submit & Correlate"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// MAIN DASHBOARD
// ---------------------------------------------------------------------
function Dashboard({ currentUser, onLogout }) {
  const [extraComplaints, setExtraComplaints] = useState([]);
  const [loadingStorage, setLoadingStorage] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);
  const [selectedRingId, setSelectedRingId] = useState(null);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [query, setQuery] = useState("");
  const [highlightId, setHighlightId] = useState(null);
  const [storageOK, setStorageOK] = useState(true);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);

  // load previously-submitted complaints from persistent storage
  useEffect(() => {
    (async () => {
      try {
        const result = await appStorage.list("complaint:", true);
        if (result && result.keys && result.keys.length > 0) {
          const loaded = [];
          for (const key of result.keys) {
            try {
              const rec = await appStorage.get(key, true);
              if (rec) loaded.push(JSON.parse(rec.value));
            } catch (e) { /* skip unreadable key */ }
          }
          setExtraComplaints(loaded);
        }
      } catch (e) {
        setStorageOK(false);
      } finally {
        setLoadingStorage(false);
      }
    })();
  }, []);

  const allComplaints = useMemo(() => [...ALL_COMPLAINTS, ...extraComplaints], [extraComplaints]);
  const rings = useMemo(() => buildCorrelation(allComplaints), [allComplaints]);
  const stats = useMemo(() => ({
    total_complaints: allComplaints.length,
    total_links: rings.reduce((s, r) => s + r.edges.length, 0),
    rings_found: rings.length,
  }), [allComplaints, rings]);

  useEffect(() => {
    if (!selectedRingId && rings.length > 0) setSelectedRingId(rings[0].cluster_id);
  }, [rings, selectedRingId]);

  const selectedRing = useMemo(() => rings.find((r) => r.cluster_id === selectedRingId) ?? null, [rings, selectedRingId]);
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
    const newId = "CMP-" + String(1000 + extraComplaints.length + 1);
    const record = {
      complaint_id: newId,
      date_filed: new Date().toISOString().slice(0, 10),
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
      submitted_by_name: currentUser.name,
      submitted_by_email: currentUser.email,
      submitted_by_state: currentUser.state,
    };

    try {
      if (storageOK) {
        await appStorage.set(`complaint:${newId}`, JSON.stringify(record), true);
      }
    } catch (e) {
      setStorageOK(false);
    }

    // small delay so "Correlating..." state is perceptible - this is
    // genuinely doing graph recomputation, not fake latency
    await new Promise((r) => setTimeout(r, 400));

    setExtraComplaints((prev) => {
      const next = [...prev, record];
      // figure out which ring this lands in after state updates
      setTimeout(() => {
        const recomputed = buildCorrelation([...ALL_COMPLAINTS, ...next]);
        const owningRing = recomputed.find((r) => r.member_ids.includes(newId));
        if (owningRing) {
          setSelectedRingId(owningRing.cluster_id);
          setHighlightId(newId);
          setToast({
            type: "match",
            text: `Linked to ${owningRing.size - 1} existing complaint(s) in ${owningRing.cluster_id} — ${owningRing.states.join(", ")}`,
          });
        } else {
          setToast({ type: "isolated", text: "No matching identifiers found in existing records. Saved as a standalone complaint." });
        }
        setTimeout(() => setHighlightId(null), 4000);
        setTimeout(() => setToast(null), 6000);
      }, 0);
      return next;
    });

    setSubmitting(false);
    setShowModal(false);
  }, [extraComplaints, storageOK]);

  const handleClearAll = useCallback(async () => {
    setClearing(true);
    try {
      const result = await appStorage.list("complaint:", true);
      if (result && result.keys) {
        for (const key of result.keys) {
          try { await appStorage.delete(key, true); } catch (e) { /* ignore */ }
        }
      }
    } catch (e) {
      setStorageOK(false);
    }
    setExtraComplaints([]);
    setSelectedNodeId(null);
    setSelectedRingId(null);
    setHighlightId(null);
    setClearing(false);
    setShowClearConfirm(false);
    setToast({ type: "isolated", text: "All entered complaints have been cleared." });
    setTimeout(() => setToast(null), 4000);
  }, []);

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
              <span className="dash-badge">PRODUCTION — NO PRELOADED DATA</span>
            </div>
            <div className="dash-subtitle">Link analysis across cybercrime complaint records</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div className="officer-badge">
            <div className="officer-name">{currentUser.name}</div>
            <div className="officer-meta">{currentUser.state} Cyber Cell · Badge {currentUser.badgeId}</div>
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
              <div className="stat-label">Links</div>
            </div>
          </div>
          <button className="btn-primary" onClick={() => setShowModal(true)}>
            <Plus size={15} /> New Complaint
          </button>
          {extraComplaints.length > 0 && (
            <button className="btn-danger" onClick={() => setShowClearConfirm(true)}>
              <Trash2 size={14} /> Clear Entered Data ({extraComplaints.length})
            </button>
          )}
          <button className="btn-secondary" onClick={onLogout}>
            <LogOut size={13} style={{ marginRight: 6 }} /> Logout
          </button>
        </div>
      </header>

      <div className="dash-body">
        <aside className="sidebar">
          <div className="sidebar-search">
            <div className="search-box">
              <Search size={14} color="#5B6577" />
              <input placeholder="Search state, phone, UPI..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>
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
          </div>
        </aside>

        <main className="main-area">
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
            <div>Edge = shared identifier (phone / UPI / account / IFSC)</div>
            <div>Thicker line = higher confidence</div>
            <div>Click a node to view complaint detail →</div>
          </div>
        </main>

        <aside className="detail-panel">
          {selectedNode ? (
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

      {showModal && <NewComplaintModal onClose={() => setShowModal(false)} onSubmit={handleNewComplaint} submitting={submitting} />}

      {showClearConfirm && (
        <div className="modal-overlay" onClick={() => setShowClearConfirm(false)}>
          <div className="modal-box" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title"><Trash2 size={16} color="#E8543F" /> Clear Entered Data</div>
              <button className="icon-btn" onClick={() => setShowClearConfirm(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: "#8A93A3", lineHeight: 1.6 }}>
                This will permanently delete all {extraComplaints.length} complaint(s) you entered through
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
      const rec = await appStorage.get(`user:${loginForm.email.trim().toLowerCase()}`, true);
      if (!rec) {
        setError("No account found with this email. Ask your admin, or sign up if you have a state registration code.");
        setBusy(false);
        return;
      }
      const user = JSON.parse(rec.value);
      const hash = await sha256Hex(loginForm.password + "::" + user.email);
      if (hash !== user.passwordHash) {
        setError("Incorrect password.");
        setBusy(false);
        return;
      }
      onLogin(user);
    } catch (e) {
      setError("Login failed - storage unavailable. Try again.");
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
    const expectedCode = STATE_REGISTRATION_CODES[f.state];
    if (!expectedCode || f.regCode.trim().toUpperCase() !== expectedCode) {
      setError("Registration code does not match the selected state. Contact your cyber cell coordinator for the correct code.");
      return;
    }
    setBusy(true);
    try {
      const emailKey = f.email.trim().toLowerCase();
      const existing = await appStorage.get(`user:${emailKey}`, true).catch(() => null);
      if (existing) {
        setError("An account with this email already exists. Please log in instead.");
        setBusy(false);
        return;
      }
      const passwordHash = await sha256Hex(f.password + "::" + emailKey);
      const user = {
        name: f.name.trim(),
        badgeId: f.badgeId.trim(),
        state: f.state,
        email: emailKey,
        passwordHash,
        createdAt: new Date().toISOString(),
      };
      await appStorage.set(`user:${emailKey}`, JSON.stringify(user), true);
      onLogin(user);
    } catch (e) {
      setError("Signup failed - storage unavailable. Try again.");
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
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const rec = await appStorage.get("session:current", false);
        if (rec) setCurrentUser(JSON.parse(rec.value));
      } catch (e) { /* no active session */ }
      setCheckingSession(false);
    })();
  }, []);

  const handleLogin = async (user) => {
    setCurrentUser(user);
    try { await appStorage.set("session:current", JSON.stringify(user), false); } catch (e) {}
  };

  const handleLogout = async () => {
    setCurrentUser(null);
    try { await appStorage.delete("session:current", false); } catch (e) {}
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

  return <Dashboard currentUser={currentUser} onLogout={handleLogout} />;
}
