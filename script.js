/* ==========================================================================
   VitalScan — script.js
   All logic lives here: form validation, BMI + health analysis, the vitals
   monitor cards, localStorage-backed records (save/search/delete), PDF
   export, dark/light theme, and the header ECG animation.
   ========================================================================== */

(() => {
  'use strict';

  const STORAGE_KEY = 'vitalscan.records.v1';
  const THEME_KEY = 'vitalscan.theme';

  // Base URL of the optional VitalScan backend (see /backend). Only used by
  // the "Email report" button — everything else works with no server at all.
  const API_BASE_URL = 'http://localhost:3001';

  /* ---------------------------------------------------------------------
     Reference ranges. Centralised so every status calculation (cards,
     analysis banner, table dots, PDF) reads from the same source of truth.
     --------------------------------------------------------------------- */
  const RANGES = {
    sugar:   { low: 70,  normalMax: 100, warnMax: 125 },        // mg/dL fasting
    hr:      { low: 60,  normalMax: 100, warnLow: 50, warnMax: 110 }, // bpm
    sys:     { low: 90,  normalMax: 120, warnMax: 129 },        // mmHg systolic
    dia:     { low: 60,  normalMax: 80,  warnMax: 89 },         // mmHg diastolic
    bmi:     { underweight: 18.5, normalMax: 24.9, overweightMax: 29.9 }
  };

  const $ = (id) => document.getElementById(id);

  /* =======================================================================
     Clock
     ======================================================================= */
  function tickClock(){
    const now = new Date();
    const dtEl = $('datetime');
    if (dtEl) dtEl.textContent = now.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }
  tickClock();
  setInterval(tickClock, 30000);

  /* =======================================================================
     Theme toggle (persisted)
     ======================================================================= */
  function applyTheme(theme){
    document.body.setAttribute('data-theme', theme);
    const themeIcon = $('themeIcon');
    if (themeIcon) themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
    localStorage.setItem(THEME_KEY, theme);
  }
  applyTheme(localStorage.getItem(THEME_KEY) || 'light');
  const themeToggle = $('themeToggle');
  if (themeToggle) themeToggle.addEventListener('click', () => {
    const current = document.body.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });

  /* =======================================================================
     ECG strip — speeds up/slows down with the last known heart rate
     ======================================================================= */
  function setEcgSpeed(bpm){
    const hr = Number(bpm) || 72;
    // Roughly two "beats" per loop of the traced path; scale duration to hr.
    const duration = Math.max(1.0, Math.min(4.5, 130 / hr));
    const ecgLine = $('ecgLine');
    if (ecgLine) ecgLine.style.animationDuration = duration + 's';
  }
  setEcgSpeed(72);

  /* =======================================================================
     Status helpers — each returns 'normal' | 'warning' | 'danger'
     ======================================================================= */
  function statusForSugar(v){
    if (v < RANGES.sugar.low) return 'danger';
    if (v <= RANGES.sugar.normalMax) return 'normal';
    if (v <= RANGES.sugar.warnMax) return 'warning';
    return 'danger';
  }
  function statusForHr(v){
    if (v < RANGES.hr.warnLow) return 'danger';
    if (v < RANGES.hr.low) return 'warning';
    if (v <= RANGES.hr.normalMax) return 'normal';
    if (v <= RANGES.hr.warnMax) return 'warning';
    return 'danger';
  }
  function statusForBp(sys, dia){
    const sysStatus = sys < RANGES.sys.low ? 'danger' : sys <= RANGES.sys.normalMax ? 'normal' : sys <= RANGES.sys.warnMax ? 'warning' : 'danger';
    const diaStatus = dia < RANGES.dia.low ? 'danger' : dia <= RANGES.dia.normalMax ? 'normal' : dia <= RANGES.dia.warnMax ? 'warning' : 'danger';
    return worst([sysStatus, diaStatus]);
  }
  function statusForBmi(v){
    if (v < RANGES.bmi.underweight) return 'warning';
    if (v <= RANGES.bmi.normalMax) return 'normal';
    if (v <= RANGES.bmi.overweightMax) return 'warning';
    return 'danger';
  }
  function worst(statuses){
    if (statuses.includes('danger')) return 'danger';
    if (statuses.includes('warning')) return 'warning';
    return 'normal';
  }
  function bmiCategory(v){
    if (v < RANGES.bmi.underweight) return 'Underweight';
    if (v <= RANGES.bmi.normalMax) return 'Normal weight';
    if (v <= RANGES.bmi.overweightMax) return 'Overweight';
    return 'Obese';
  }

  /* =======================================================================
     Form validation
     ======================================================================= */
  function clearErrors(){
    document.querySelectorAll('.field__error').forEach(e => e.textContent = '');
    document.querySelectorAll('.field input').forEach(i => i.classList.remove('invalid'));
  }
  function setError(fieldId, message){
    $('err-' + fieldId).textContent = message;
    $(fieldId).classList.add('invalid');
  }

  function validate(values){
    let valid = true;
    if (!values.name){ setError('name', 'Name is required.'); valid = false; }
    if (!values.age || values.age < 1 || values.age > 120){ setError('age', 'Enter an age between 1–120.'); valid = false; }
    if (!values.height || values.height < 50 || values.height > 250){ setError('height', 'Enter height in cm (50–250).'); valid = false; }
    if (!values.weight || values.weight < 10 || values.weight > 400){ setError('weight', 'Enter weight in kg (10–400).'); valid = false; }
    if (values.bloodSugar === '' || isNaN(values.bloodSugar) || values.bloodSugar < 0){ setError('bloodSugar', 'Enter a valid blood sugar value.'); valid = false; }
    if (values.heartRate === '' || isNaN(values.heartRate) || values.heartRate < 0){ setError('heartRate', 'Enter a valid heart rate.'); valid = false; }
    if (values.bpSystolic === '' || isNaN(values.bpSystolic) || values.bpSystolic < 0){ setError('bpSystolic', 'Enter a valid systolic value.'); valid = false; }
    if (values.bpDiastolic === '' || isNaN(values.bpDiastolic) || values.bpDiastolic < 0){ setError('bpDiastolic', 'Enter a valid diastolic value.'); valid = false; }
    return valid;
  }

  function readForm(){
    return {
      name: $('name').value.trim(),
      age: Number($('age').value),
      height: Number($('height').value),
      weight: Number($('weight').value),
      bloodSugar: $('bloodSugar').value === '' ? '' : Number($('bloodSugar').value),
      heartRate: $('heartRate').value === '' ? '' : Number($('heartRate').value),
      bpSystolic: $('bpSystolic').value === '' ? '' : Number($('bpSystolic').value),
      bpDiastolic: $('bpDiastolic').value === '' ? '' : Number($('bpDiastolic').value),
    };
  }

  /* =======================================================================
     Analyze → update monitor cards + analysis banner + save record
     ======================================================================= */
  function updateVitalCard(prefix, valueText, status, statusLabel){
    const card = document.querySelector(`.vital-card[data-vital="${prefix}"]`);
    $('v' + capitalize(prefix)).textContent = valueText;
    $('v' + capitalize(prefix) + 'Status').textContent = statusLabel;
    card.classList.remove('is-normal', 'is-warning', 'is-danger');
    card.classList.add('is-' + status);
    card.classList.remove('just-updated');
    void card.offsetWidth; // restart animation
    card.classList.add('just-updated');
  }
  function capitalize(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

  function runAnalysis(values){
    const heightM = values.height / 100;
    const bmi = values.weight / (heightM * heightM);
    const bmiRounded = Math.round(bmi * 10) / 10;

    const sugarStatus = statusForSugar(values.bloodSugar);
    const hrStatus = statusForHr(values.heartRate);
    const bpStatus = statusForBp(values.bpSystolic, values.bpDiastolic);
    const bmiStatus = statusForBmi(bmiRounded);

    updateVitalCard('bmi', bmiRounded.toFixed(1), bmiStatus, bmiCategory(bmiRounded));
    updateVitalCard('sugar', values.bloodSugar + ' mg/dL', sugarStatus, labelFor(sugarStatus));
    updateVitalCard('hr', values.heartRate + ' bpm', hrStatus, labelFor(hrStatus));
    updateVitalCard('bp', values.bpSystolic + '/' + values.bpDiastolic, bpStatus, labelFor(bpStatus));

    setEcgSpeed(values.heartRate);

    const overall = worst([sugarStatus, hrStatus, bpStatus, bmiStatus]);
    const notes = [];
    if (sugarStatus !== 'normal') notes.push(`Blood sugar (${values.bloodSugar} mg/dL) is ${labelFor(sugarStatus).toLowerCase()} — fasting reference range is 70–100 mg/dL.`);
    if (hrStatus !== 'normal') notes.push(`Heart rate (${values.heartRate} bpm) is ${labelFor(hrStatus).toLowerCase()} — resting reference range is 60–100 bpm.`);
    if (bpStatus !== 'normal') notes.push(`Blood pressure (${values.bpSystolic}/${values.bpDiastolic} mmHg) is ${labelFor(bpStatus).toLowerCase()} — reference range is 90–120 / 60–80 mmHg.`);
    if (bmiStatus !== 'normal') notes.push(`BMI (${bmiRounded.toFixed(1)}) falls in the "${bmiCategory(bmiRounded)}" range.`);
    if (notes.length === 0) notes.push('All recorded vitals fall within typical reference ranges.');

    renderAnalysis(values, overall, bmiRounded, notes);

    return {
      ...values,
      bmi: bmiRounded,
      sugarStatus, hrStatus, bpStatus, bmiStatus,
      overall,
      date: new Date().toISOString()
    };
  }

  function labelFor(status){
    return status === 'normal' ? 'Normal' : status === 'warning' ? 'Borderline' : 'Out of range';
  }

  function renderAnalysis(values, overall, bmi, notes){
    const box = $('analysis');
    box.hidden = false;
    box.classList.remove('is-normal', 'is-warning', 'is-danger');
    box.classList.add('is-' + overall);

    $('analysisBadge').textContent = overall === 'normal' ? '✓ Normal' : overall === 'warning' ? '⚠ Needs attention' : '⛔ Out of range';

    $('analysisHeadline').textContent = overall === 'normal'
      ? `${values.name}, your vitals look healthy.`
      : overall === 'warning'
        ? `${values.name}, a few readings are borderline.`
        : `${values.name}, some readings need prompt attention.`;

    $('analysisText').textContent = overall === 'normal'
      ? 'Keep up your current routine — regular monitoring helps catch changes early.'
      : 'Consider discussing these readings with a healthcare professional, especially if they persist over multiple checks.';

    const list = $('analysisNotes');
    list.innerHTML = '';
    notes.forEach(n => {
      const li = document.createElement('li');
      li.textContent = n;
      list.appendChild(li);
    });
  }

  /* =======================================================================
     Records: save / load / render / search / delete / clear all
     ======================================================================= */
  function getRecords(){
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch { return []; }
  }
  function setRecords(records){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, 200)));
  }
  function saveRecord(record){
    const records = getRecords();
    records.unshift({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), ...record });
    setRecords(records);
    renderRecords();
  }
  function deleteRecord(id){
    setRecords(getRecords().filter(r => r.id !== id));
    renderRecords();
  }
  function clearAllRecords(){
    localStorage.removeItem(STORAGE_KEY);
    renderRecords();
  }

  function renderRecords(){
    const query = $('searchRecords').value.trim().toLowerCase();
    const records = getRecords().filter(r => !query || r.name.toLowerCase().includes(query));
    const tbody = $('recordsBody');
    tbody.innerHTML = '';

    $('recordsEmpty').style.display = records.length ? 'none' : 'block';

    records.forEach(r => {
      const tr = document.createElement('tr');
      const dateStr = new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      tr.innerHTML = `
        <td><span class="status-dot is-${r.overall}" title="${labelFor(r.overall)}"></span></td>
        <td>${escapeHtml(r.name)} <span style="color:var(--muted); font-size:.78rem;">(${r.age})</span></td>
        <td class="mono">${r.age}</td>
        <td class="mono">${r.bloodSugar}</td>
        <td class="mono">${r.bpSystolic}/${r.bpDiastolic}</td>
        <td class="mono">${r.heartRate}</td>
        <td class="mono">${r.bmi.toFixed(1)}</td>
        <td>${dateStr}</td>
        <td><button class="btn--tiny" data-delete="${r.id}">Delete</button></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteRecord(btn.getAttribute('data-delete')));
    });
  }

  function escapeHtml(str){
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  $('searchRecords').addEventListener('input', renderRecords);
  $('clearAllBtn').addEventListener('click', () => {
    if (getRecords().length === 0) return;
    if (confirm('Delete all saved health records? This cannot be undone.')) clearAllRecords();
  });

  /* =======================================================================
     PDF export of the most recent analysis
     ======================================================================= */
  let lastResult = null;

  // Builds the jsPDF document for a given result. Shared by the "Download"
  // and "Email" actions so both produce byte-identical reports.
  function buildReportDoc(r){
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    doc.setFontSize(18);
    doc.text('VitalScan — Health Report', 14, 20);
    doc.setFontSize(10);
    doc.setTextColor(120);
    doc.text(new Date(r.date).toLocaleString('en-US'), 14, 27);

    doc.setDrawColor(220);
    doc.line(14, 32, 196, 32);

    doc.setTextColor(20);
    doc.setFontSize(12);
    let y = 42;
    const row = (label, value) => {
      doc.setFont(undefined, 'bold');
      doc.text(label, 14, y);
      doc.setFont(undefined, 'normal');
      doc.text(String(value), 80, y);
      y += 9;
    };
    row('Patient name:', r.name);
    row('Age:', r.age);
    row('Height / Weight:', `${r.height} cm / ${r.weight} kg`);
    row('BMI:', `${r.bmi.toFixed(1)} (${bmiCategory(r.bmi)})`);
    row('Blood sugar:', `${r.bloodSugar} mg/dL (${labelFor(r.sugarStatus)})`);
    row('Heart rate:', `${r.heartRate} bpm (${labelFor(r.hrStatus)})`);
    row('Blood pressure:', `${r.bpSystolic}/${r.bpDiastolic} mmHg (${labelFor(r.bpStatus)})`);
    row('Overall status:', labelFor(r.overall));

    y += 4;
    doc.line(14, y, 196, y);
    y += 10;
    doc.setFontSize(10);
    doc.setTextColor(120);
    const disclaimer = 'This report is generated from self-reported readings and is not a medical diagnosis. Consult a healthcare professional for clinical advice.';
    const lines = doc.splitTextToSize(disclaimer, 182);
    doc.text(lines, 14, y);

    return doc;
  }

  function downloadPdf(){
    if (!lastResult) return;
    const doc = buildReportDoc(lastResult);
    const r = lastResult;
    doc.save(`vitalscan-report-${r.name.replace(/\s+/g, '_')}-${new Date(r.date).toISOString().slice(0,10)}.pdf`);
  }

  $('downloadPdfBtn').addEventListener('click', downloadPdf);

  /* =======================================================================
     Email the report — posts a base64 PDF to the optional backend (see
     /backend/server.js), which relays it as an email attachment via SMTP.
     ======================================================================= */
  async function emailReport(){
    const statusEl = $('emailStatus');
    const emailInput = $('reportEmail');
    const toEmail = emailInput.value.trim();

    if (!lastResult){
      statusEl.textContent = 'Run an analysis first.';
      statusEl.className = 'email-report__status is-error';
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)){
      statusEl.textContent = 'Enter a valid recipient email address.';
      statusEl.className = 'email-report__status is-error';
      emailInput.focus();
      return;
    }

    const btn = $('emailPdfBtn');
    if (btn) btn.disabled = true;
    statusEl.textContent = 'Sending…';
    statusEl.className = 'email-report__status';

    try {
      const doc = buildReportDoc(lastResult);
      // dataUriString looks like "data:application/pdf;filename=...;base64,XXXX"
      const dataUri = doc.output('datauristring');
      const pdfBase64 = dataUri.split(',')[1];

      const res = await fetch(`${API_BASE_URL}/api/send-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toEmail,
          patientName: lastResult.name,
          pdfBase64
        })
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) throw new Error(data.error || 'The server could not send the email.');

      statusEl.textContent = data.message || `Report sent to ${toEmail}.`;
      statusEl.className = 'email-report__status is-success';
    } catch (err) {
      statusEl.textContent = err.message.includes('fetch')
        ? 'Could not reach the backend. Is it running? (see /backend README)'
        : err.message;
      statusEl.className = 'email-report__status is-error';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  const emailBtn = $('emailPdfBtn');
  if (emailBtn) emailBtn.addEventListener('click', emailReport);

  /* =======================================================================
     Form wiring
     ======================================================================= */
  $('healthForm').addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors();
    const values = readForm();
    if (!validate(values)) return;

    lastResult = runAnalysis(values);
    saveRecord(lastResult);
  });

  $('resetBtn').addEventListener('click', () => {
    $('healthForm').reset();
    clearErrors();
    $('analysis').hidden = true;
    ['bmi','sugar','hr','bp'].forEach(p => {
      const card = document.querySelector(`.vital-card[data-vital="${p}"]`);
      card.classList.remove('is-normal','is-warning','is-danger');
      $('v' + capitalize(p)).textContent = '—';
      $('v' + capitalize(p) + 'Status').textContent = 'awaiting data';
    });
    setEcgSpeed(72);
    $('name').focus();
  });

  /* =======================================================================
     Init
     ======================================================================= */
  renderRecords();
})();