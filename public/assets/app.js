/**
 * public/assets/app.js
 * Bulk Mailer — Main portal frontend logic (app.html)
 * Plain JS, no framework, fetch API.
 */
(function () {
  'use strict';

  // ── State ──
  let currentUser    = null;
  let attachmentMode = 'network';
  let currentJobId   = null;
  let excelFile      = null;
  let zipFile        = null;
  let parsedColumns  = [];
  let totalRows      = 0;   // real row count from API (previewRows is only 3)
  let parsedRows     = [];  // preview rows (first 3) for preview modal only
  let pollInterval   = null;
  let quillBody      = null;  // Quill rich-text editor instance

  // ── Grab DOM elements ──
  const $ = (id) => document.getElementById(id);

  // ══════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════
  async function init() {
    const meRes  = await fetch('/api/auth/me');
    const meData = await meRes.json();
    if (!meData.success) {
      window.location.href = '/index.html';
      return;
    }
    currentUser = meData.user;
    $('user-dept-badge').textContent = `${currentUser.displayName || currentUser.username} · ${currentUser.department || ''}`;

    // Initialise Quill rich-text editor
    quillBody = new Quill('#body-tpl-editor', {
      theme: 'snow',
      placeholder: 'Dear {{Name}},\n\nPlease find your document attached.\n\nRegards,\nHR Team',
      modules: {
        toolbar: [
          ['bold', 'italic', 'underline'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          [{ align: [] }],
          ['clean'],
        ],
      },
    });

    // Track when Quill editor is focused so chips insert into it
    quillBody.on('selection-change', (range) => {
      if (range) window._lastFocused = 'body';
    });

    // Pre-fill from address from allowedSenders for dept
    prefillFromAddress();

    bindEvents();
  }

  function prefillFromAddress() {
    const deptMap = {
      HR:      'hr@example.com',
      Finance: 'finance@example.com',
      Admin:   'admin@example.com',
      IT:      'it@example.com',
    };
    const addr = deptMap[currentUser.department];
    if (addr) $('from-address').value = addr;
  }

  // ══════════════════════════════════════════════
  // EVENT BINDINGS
  // ══════════════════════════════════════════════
  function bindEvents() {
    // Logout
    $('btn-logout').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/index.html';
    });

    // Tabs — guard Compose and Send so user can't skip the upload step
    $('tab-btn-data').addEventListener('click', () => switchTab('data'));
    $('tab-btn-compose').addEventListener('click', () => {
      if (!currentJobId) {
        showAlert('Upload your Excel file in Step 1 first — column chips will appear automatically once uploaded.', 'warning');
        switchTab('data');
        return;
      }
      switchTab('compose');
    });
    $('tab-btn-send').addEventListener('click', () => {
      if (!currentJobId) {
        showAlert('Complete Step 1 (upload Excel) before proceeding to Send.', 'warning');
        switchTab('data');
        return;
      }
      updateSendSummary();
      switchTab('send');
    });

    // Tab nav shortcuts
    // Data → Compose (after upload)
    $('btn-goto-compose').addEventListener('click', () => {
      if (!currentJobId) { showAlert('Please upload an Excel file first.', 'warning'); return; }
      switchTab('compose');
    });
    // Compose → back to Data (both the nav button and the inline chip-empty link)
    $('btn-goto-data').addEventListener('click', () => switchTab('data'));
    document.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'link-goto-data') {
        e.preventDefault();
        switchTab('data');
      }
    });
    // Compose → Send: validate compose fields, then create the actual job
    $('btn-goto-send').addEventListener('click', async () => {
      if (!currentJobId) { showAlert('Please upload data in Step 1 first.', 'warning'); return; }
      if (!validateCompose()) return;

      const btn = $('btn-goto-send');
      btn.disabled = true;
      btn.textContent = 'Creating job…';

      const ok = await handleCreateJob();

      btn.disabled = false;
      btn.textContent = 'Next: Review & Send →';

      if (!ok) return;
      updateSendSummary();
      updateStepper('send', true, false);
      switchTab('send');
    });

    // Re-upload Excel — reset data state, stay on Data tab
    $('btn-reupload').addEventListener('click', () => {
      excelFile    = null;
      zipFile      = null;
      currentJobId = null;
      totalRows    = 0;
      parsedColumns = [];
      parsedRows    = [];
      $('excel-file-name').classList.add('hidden');
      $('zip-file-name').classList.add('hidden');
      $('validation-section').classList.add('hidden');
      $('columns-section').classList.add('hidden');
      $('preview-section').classList.add('hidden');
      $('data-nav').classList.add('hidden');
      $('job-id-badge').classList.add('hidden');
      $('excel-input').value = '';
      if ($('zip-input')) $('zip-input').value = '';
      // Reset chips in compose tab back to placeholder message
      $('chips-compose').innerHTML = '<span class="chip-empty">No columns loaded yet — <a href="#" id="link-goto-data" style="color:var(--clr-accent);text-decoration:underline">go to Step 1 to upload your Excel</a> and chips will appear here automatically.</span>';
      updateUploadButton();
      updateStepper('data', false, false);
      showAlert('Data cleared — select a new Excel file to upload.', 'info');
    });

    // New Job reset
    $('btn-new-job').addEventListener('click', () => {
      // Reset all state and return to Compose tab
      currentJobId  = null;
      excelFile     = null;
      zipFile       = null;
      parsedColumns = [];
      parsedRows    = [];
      totalRows     = 0;
      stopPolling();
      // Reset form fields
      $('from-address').value = '';
      $('subject-tpl').value  = '';
      if (quillBody) quillBody.setText('');
      $('schedule-at').value    = '';
      $('schedule-at').disabled = false;
      $('schedule-at').title    = '';
      $('excel-input').value    = '';
      if ($('zip-input')) $('zip-input').value = '';
      // Reset UI sections
      $('job-id-badge').classList.add('hidden');
      $('validation-section').classList.add('hidden');
      $('columns-section').classList.add('hidden');
      $('preview-section').classList.add('hidden');
      $('data-nav').classList.add('hidden');
      $('progress-section').classList.add('hidden');
      $('live-log-section').classList.add('hidden');
      $('completion-banner').classList.add('hidden');
      $('btn-start-job').classList.remove('hidden');
      $('btn-pause-job').classList.add('hidden');
      $('btn-retry-job').classList.add('hidden');
      $('btn-start-job').disabled = true;
      $('btn-start-job').textContent = '🚀 Send Now';
      $('excel-file-name').classList.add('hidden');
      $('zip-file-name').classList.add('hidden');
      prefillFromAddress();
      updateUploadButton();
      // Reset chips
      $('chips-compose').innerHTML = '<span class="chip-empty">No columns loaded yet — <a href="#" id="link-goto-data" style="color:var(--clr-accent);text-decoration:underline">go to Step 1 to upload your Excel</a> and chips will appear here automatically.</span>';
      // Reset stepper — back to step 1 (Data)
      updateStepper('data', false, false);
      switchTab('data');
      showAlert('Ready for a new job!', 'success');
    });

    // Attachment mode toggle
    ['zip', 'network'].forEach((mode) => {
      $(`mode-${mode}`).addEventListener('click', () => setAttachmentMode(mode));
      $(`mode-${mode}`).addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAttachmentMode(mode); }
      });
    });

    // Subject — track cursor for chip insertion (body is tracked via Quill selection-change)
    $('subject-tpl').addEventListener('focus', () => { window._lastFocused = 'subject'; });

    // Manual placeholder insert — works before any Excel is uploaded
    const manualInput = $('manual-placeholder-input');
    const doInsert = () => {
      const col = manualInput.value.trim();
      if (!col) { manualInput.focus(); return; }
      insertPlaceholder(col);
      manualInput.value = '';
      manualInput.focus();
    };
    $('btn-insert-placeholder').addEventListener('click', doInsert);
    manualInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doInsert(); } });

    // Excel upload
    setupDropZone('excel-drop-zone', 'excel-input', handleExcelSelect);

    // ZIP upload
    setupDropZone('zip-drop-zone', 'zip-input', handleZipSelect);

    // Upload button
    $('btn-upload-job').addEventListener('click', handleUploadJob);

    // Send tab actions
    $('btn-preview-mails').addEventListener('click', handlePreviewMails);
    $('btn-start-job').addEventListener('click', () => {
      $('confirm-count').textContent = totalRows;   // real row count
      $('confirm-modal').classList.remove('hidden');
    });
    $('btn-pause-job').addEventListener('click', handlePauseJob);
    $('btn-retry-job').addEventListener('click', handleRetryJob);

    // Modals
    ['close-preview-modal', 'btn-close-preview'].forEach((id) => {
      $(id).addEventListener('click', () => $('preview-modal').classList.add('hidden'));
    });
    ['close-confirm-modal', 'btn-cancel-confirm'].forEach((id) => {
      $(id).addEventListener('click', () => $('confirm-modal').classList.add('hidden'));
    });
    $('btn-confirm-send').addEventListener('click', handleStartJob);

    // Close modals on backdrop click
    $('preview-modal').addEventListener('click', (e) => {
      if (e.target === $('preview-modal')) $('preview-modal').classList.add('hidden');
    });
    $('confirm-modal').addEventListener('click', (e) => {
      if (e.target === $('confirm-modal')) $('confirm-modal').classList.add('hidden');
    });
  }

  // ══════════════════════════════════════════════
  // TABS + STEPPER
  // ══════════════════════════════════════════════
  function switchTab(name) {
    ['data', 'compose', 'send'].forEach((n) => {
      const btn  = $(`tab-btn-${n}`);
      const pane = $(`tab-${n}`);
      const isActive = n === name;
      btn.classList.toggle('active', isActive);
      pane.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive);
    });

    // ── Restore tab state on every entry so back-navigation always shows data ──
    if (name === 'data' && currentJobId) {
      // Job already created — make sure all post-upload sections are visible
      $('validation-section').classList.remove('hidden');
      $('columns-section').classList.remove('hidden');
      $('preview-section').classList.remove('hidden');
      $('data-nav').classList.remove('hidden');
      $('job-id-badge').classList.remove('hidden');
    }

    if (name === 'compose' && parsedColumns.length > 0) {
      // Re-render chips in case innerHTML was lost (e.g. browser repaint edge case)
      renderColumns(parsedColumns);
    }
  }

  /**
   * Update the stepper visual state.
   * Step order: 1=Data, 2=Compose, 3=Send
   *
   * @param {'data'|'compose'|'send'} current   Active step
   * @param {boolean} uploadComplete  Step 1 finished (Excel uploaded, job created)
   * @param {boolean} sendComplete    Step 3 finished (job completed)
   */
  function updateStepper(current, uploadComplete, sendComplete) {
    // Step 1: Data
    const s1 = $('step-num-data');
    const b1 = $('tab-btn-data');
    if (uploadComplete && current !== 'data') {
      s1.textContent = '✓'; b1.classList.add('done'); b1.classList.remove('active');
    } else {
      s1.textContent = '1'; b1.classList.remove('done');
    }

    // Step 2: Compose
    const s2 = $('step-num-compose');
    const b2 = $('tab-btn-compose');
    if (uploadComplete && sendComplete && current !== 'compose') {
      s2.textContent = '✓'; b2.classList.add('done'); b2.classList.remove('active');
    } else {
      s2.textContent = '2'; b2.classList.remove('done');
    }

    // Connectors — conn-1 lights up when data uploaded, conn-2 when job done
    $('conn-1').classList.toggle('done', uploadComplete);
    $('conn-2').classList.toggle('done', sendComplete);

    // Step 3: Send
    const s3 = $('step-num-send');
    const b3 = $('tab-btn-send');
    if (sendComplete) {
      s3.textContent = '✓'; b3.classList.add('done'); b3.classList.remove('active');
    } else {
      s3.textContent = '3'; b3.classList.remove('done');
    }
  }

  // ══════════════════════════════════════════════
  // ATTACHMENT MODE
  // ══════════════════════════════════════════════
  function setAttachmentMode(mode) {
    attachmentMode = mode;
    $('mode-zip').classList.toggle('selected',     mode === 'zip');
    $('mode-network').classList.toggle('selected', mode === 'network');
    $('mode-zip').setAttribute('aria-checked',     mode === 'zip');
    $('mode-network').setAttribute('aria-checked', mode === 'network');
    $('mode-hint-zip').classList.toggle('hidden',     mode !== 'zip');
    $('mode-hint-network').classList.toggle('hidden', mode !== 'network');
    $('zip-upload-section').classList.toggle('hidden', mode !== 'zip');
    updateUploadButton();
  }

  // ══════════════════════════════════════════════
  // DROP ZONES
  // ══════════════════════════════════════════════
  function setupDropZone(zoneId, inputId, handler) {
    const zone  = $(zoneId);
    const input = $(inputId);

    zone.addEventListener('click',   () => input.click());
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });

    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) handler(file);
    });

    input.addEventListener('change', () => {
      if (input.files[0]) handler(input.files[0]);
    });
  }

  function handleExcelSelect(file) {
    excelFile = file;
    $('excel-file-name').textContent = `Selected: ${file.name} (${fmtSize(file.size)})`;
    $('excel-file-name').classList.remove('hidden');
    updateUploadButton();
  }

  function handleZipSelect(file) {
    zipFile = file;
    $('zip-file-name').textContent = `Selected: ${file.name} (${fmtSize(file.size)})`;
    $('zip-file-name').classList.remove('hidden');
    updateUploadButton();
  }

  function updateUploadButton() {
    const hasExcel = !!excelFile;
    const hasZip   = attachmentMode !== 'zip' || !!zipFile;
    $('btn-upload-job').disabled = !(hasExcel && hasZip);
  }

  // ══════════════════════════════════════════════
  // STEP 1 — PARSE EXCEL (no job created yet)
  // Calls /api/jobs/parse → returns columns + preview.
  // The actual job (DB record) is created in handleCreateJob()
  // when the user reaches the Send tab.
  // ══════════════════════════════════════════════
  async function handleUploadJob() {
    if (!excelFile) { showAlert('Please select an Excel file.', 'warning'); return; }
    if (attachmentMode === 'zip' && !zipFile) {
      showAlert('Please select a ZIP file for ZIP mode.', 'warning'); return;
    }

    const fd = new FormData();
    fd.append('excel', excelFile);
    fd.append('attachmentMode', attachmentMode);
    // ZIP file included so server can validate it exists (it won't be extracted yet)
    if (attachmentMode === 'zip' && zipFile) fd.append('attachments', zipFile);

    setUploadLoading(true);
    try {
      const res  = await fetch('/api/jobs/parse', { method: 'POST', body: fd });
      const data = await res.json();

      if (!data.success) {
        showAlert(data.error || 'Failed to parse Excel.', 'danger');
        return;
      }

      parsedColumns = data.columns    || [];
      parsedRows    = data.previewRows || [];
      totalRows     = data.totalRows   || 0;

      if (data.parseErrors && data.parseErrors.length) {
        showAlert('Warnings: ' + data.parseErrors.slice(0, 3).join(' | '), 'warning');
      }

      renderValidation(data);
      renderColumns(parsedColumns);
      renderPreviewTable(data.previewRows, parsedColumns);

      $('validation-section').classList.remove('hidden');
      $('columns-section').classList.remove('hidden');
      $('preview-section').classList.remove('hidden');
      $('data-nav').classList.remove('hidden');

      // Mark data parsed (use a flag instead of jobId — job not created yet)
      currentJobId = 'parsed';   // non-null so tab guards allow navigation

      updateStepper('compose', true, false);
      switchTab('compose');
      showAlert(`${data.totalRows} recipients loaded — now compose your email below.`, 'success');

    } catch (err) {
      showAlert('Network error: ' + err.message, 'danger');
    } finally {
      setUploadLoading(false);
    }
  }

  // ══════════════════════════════════════════════
  // STEP 3 — CREATE JOB (called just before Send)
  // Sends all fields: compose + files → POST /api/jobs
  // ══════════════════════════════════════════════
  async function handleCreateJob() {
    if (!excelFile) {
      showAlert('Excel file is missing. Please go back to Step 1 and re-upload.', 'danger');
      return false;
    }

    const fromAddress     = $('from-address').value.trim();
    const subjectTemplate = $('subject-tpl').value.trim();
    const bodyTemplate    = quillBody ? quillBody.root.innerHTML.trim() : '';

    if (!fromAddress || !subjectTemplate || !bodyTemplate) {
      showAlert('Please fill in From Address, Subject, and Email Body before sending.', 'warning');
      switchTab('compose');
      return false;
    }

    const fd = new FormData();
    fd.append('fromAddress',     fromAddress);
    fd.append('subjectTemplate', subjectTemplate);
    fd.append('bodyTemplate',    bodyTemplate);
    fd.append('attachmentMode',  attachmentMode);
    fd.append('excel', excelFile);
    if (attachmentMode === 'zip' && zipFile) fd.append('attachments', zipFile);

    const sched = $('schedule-at').value;
    if (sched) fd.append('scheduledAt', new Date(sched).toISOString());

    try {
      const res  = await fetch('/api/jobs', { method: 'POST', body: fd });
      const data = await res.json();
      if (!data.success) {
        showAlert(data.error || 'Failed to create job.', 'danger');
        return false;
      }

      currentJobId = data.jobId;
      totalRows    = data.totalRows || totalRows;
      $('current-job-id').textContent = currentJobId;
      $('job-id-badge').classList.remove('hidden');
      return true;
    } catch (err) {
      showAlert('Network error creating job: ' + err.message, 'danger');
      return false;
    }
  }

  function setUploadLoading(on) {
    $('btn-upload-job').disabled = on;
    $('upload-spinner').classList.toggle('hidden', !on);
    $('upload-btn-text').textContent = on ? 'Parsing…' : 'Upload & Continue';
  }

  // ══════════════════════════════════════════════
  // VALIDATION DISPLAY
  // ══════════════════════════════════════════════
  function renderValidation(data) {
    const totalRows  = data.totalRows || 0;
    const parseErrs  = (data.parseErrors || []).filter(e => e.includes('invalid email'));
    const missingAtt = (data.parseErrors || []).filter(e => e.includes('AttachmentPath'));

    $('validation-rows').innerHTML = `
      <div class="validation-row">
        <span class="validation-icon">✅</span>
        <strong>${totalRows}</strong>&nbsp; rows loaded
      </div>
      <div class="validation-row">
        <span class="validation-icon">${parseErrs.length ? '⚠️' : '✅'}</span>
        <strong>${parseErrs.length}</strong>&nbsp; rows with invalid email (will be marked failed)
      </div>
      <div class="validation-row">
        <span class="validation-icon">${missingAtt.length ? '⚠️' : '✅'}</span>
        <strong>${missingAtt.length}</strong>&nbsp; rows with missing AttachmentPath
      </div>
    `;
  }

  // ══════════════════════════════════════════════
  // COLUMNS / CHIPS
  // ══════════════════════════════════════════════
  function renderColumns(columns) {
    const chipsData    = $('chips-data');
    const chipsCompose = $('chips-compose');

    const chipHtml = columns.map(col =>
      `<span class="chip" data-col="${esc(col)}" tabindex="0" role="button" title="Insert {{${esc(col)}}}">${esc(col)}</span>`
    ).join('');

    const html = chipHtml || '<span class="chip-empty">No columns detected.</span>';
    chipsData.innerHTML    = html;
    chipsCompose.innerHTML = html;

    // Bind click → insert placeholder
    [chipsData, chipsCompose].forEach((container) => {
      container.querySelectorAll('.chip').forEach((chip) => {
        chip.addEventListener('click',   () => insertPlaceholder(chip.dataset.col));
        chip.addEventListener('keydown', (e) => { if (e.key === 'Enter') insertPlaceholder(chip.dataset.col); });
      });
    });
  }

  function insertPlaceholder(col) {
    const placeholder = `{{${col}}}`;

    if (window._lastFocused === 'body' && quillBody) {
      // Insert into Quill at current cursor position
      const range = quillBody.getSelection(true);
      const index = range ? range.index : quillBody.getLength();
      quillBody.insertText(index, placeholder, 'user');
      quillBody.setSelection(index + placeholder.length);
      quillBody.focus();
    } else {
      // Insert into subject plain-text input
      const target = $('subject-tpl');
      const start  = target.selectionStart;
      const end    = target.selectionEnd;
      const val    = target.value;
      target.value = val.slice(0, start) + placeholder + val.slice(end);
      target.selectionStart = target.selectionEnd = start + placeholder.length;
      target.focus();
    }
  }

  // ══════════════════════════════════════════════
  // PREVIEW TABLE
  // ══════════════════════════════════════════════
  function renderPreviewTable(previewRows, columns) {
    if (!previewRows || !previewRows.length) return;

    const headers = ['email', 'subject', 'attachmentPath'];
    $('preview-thead').innerHTML = headers.map(h => `<th>${esc(h)}</th>`).join('');
    $('preview-tbody').innerHTML = previewRows.map(r => `
      <tr>
        <td class="cell-truncate">${esc(r.email || '')}</td>
        <td class="cell-truncate">${esc(r.subject || '')}</td>
        <td class="cell-truncate">${esc(r.attachmentPath || '')}</td>
      </tr>
    `).join('');
  }

  // ══════════════════════════════════════════════
  // SEND SUMMARY
  // ══════════════════════════════════════════════
  function updateSendSummary() {
    $('sum-total').textContent = totalRows || '—';   // use real count, not preview count
    $('sum-from').textContent  = $('from-address').value || '—';
    $('sum-mode').textContent  = attachmentMode === 'zip' ? '📦 ZIP' : '🌐 Network';
    $('btn-start-job').disabled = !currentJobId;
  }

  // ══════════════════════════════════════════════
  // PREVIEW MAILS
  // ══════════════════════════════════════════════
  async function handlePreviewMails() {
    if (!parsedRows.length) {
      showAlert('Upload data first to preview.', 'warning');
      return;
    }

    const res  = await fetch('/api/preview', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        subjectTemplate: $('subject-tpl').value,
        bodyTemplate:    quillBody.root.innerHTML.trim(),
        rows:            parsedRows.slice(0, 3),
      }),
    });
    const data = await res.json();
    if (!data.success) { showAlert(data.error || 'Preview failed.', 'danger'); return; }

    // Build preview cards — body rendered in sandboxed iframe (blocks XSS scripts in email HTML)
    const container = $('preview-modal-body');
    container.innerHTML = data.previews.map((p, i) => {
      // Multiple attachments: semicolon-separated raw paths → show each filename
      const attachNames = p.attachmentPath
        ? p.attachmentPath.split(';')
            .map((a) => a.trim())
            .filter(Boolean)
            .map((a) => esc(a.split(/[\\/]/).pop()))
            .join(', ')
        : '';

      const ccLine  = p.cc  ? `<div style="font-size:12px;color:#888;margin-top:2px">CC: ${esc(p.cc)}</div>`  : '';
      const bccLine = p.bcc ? `<div style="font-size:12px;color:#888;margin-top:2px">BCC: ${esc(p.bcc)}</div>` : '';

      return `
        <div class="preview-card">
          <div class="preview-header">
            <div>
              <span>Preview ${i + 1} — ${esc(p.email)}</span>
              ${ccLine}${bccLine}
            </div>
            ${attachNames ? `<span>📎 ${attachNames}</span>` : '<span class="text-muted">No attachment</span>'}
          </div>
          <div class="preview-body">
            <div class="preview-subject">${esc(p.subject)}</div>
            <iframe data-body="${esc(p.body)}" class="preview-iframe"
              sandbox="allow-same-origin"
              style="width:100%;border:none;height:240px;display:block;border-radius:4px"></iframe>
          </div>
        </div>
      `;
    }).join('');

    // Set srcdoc via JS after DOM insertion — avoids HTML-attribute escaping issues.
    // No onload/contentDocument access needed (sandbox blocks that and logs noise).
    container.querySelectorAll('.preview-iframe').forEach((frame) => {
      frame.srcdoc = frame.dataset.body || '<p style="color:#999;padding:12px">No body content.</p>';
    });

    $('preview-modal').classList.remove('hidden');
  }

  // ══════════════════════════════════════════════
  // START JOB
  // ══════════════════════════════════════════════
  async function handleStartJob() {
    $('confirm-modal').classList.add('hidden');
    if (!currentJobId) return;

    const sched = $('schedule-at').value;
    if (sched) {
      // Patch scheduledAt — already set during job creation; just enqueue
    }

    const res  = await fetch(`/api/jobs/${currentJobId}/start`, { method: 'POST' });
    const data = await res.json();

    if (!data.success) { showAlert(data.error || 'Failed to start job.', 'danger'); return; }

    showAlert('Job started — sending in progress.', 'success');
    $('btn-start-job').classList.add('hidden');
    $('btn-pause-job').classList.remove('hidden');
    $('progress-section').classList.remove('hidden');
    $('live-log-section').classList.remove('hidden');
    $('btn-export-csv').href = `/api/logs/${currentJobId}/export`;
    $('btn-export-csv').classList.remove('hidden');

    startPolling();
  }

  // ══════════════════════════════════════════════
  // PAUSE
  // ══════════════════════════════════════════════
  async function handlePauseJob() {
    const res  = await fetch(`/api/jobs/${currentJobId}/pause`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showAlert(data.message, 'success');
      $('btn-pause-job').classList.add('hidden');
      $('btn-start-job').classList.remove('hidden');
      $('btn-start-job').textContent = '▶ Resume';
    } else {
      showAlert(data.error, 'danger');
    }
  }

  // ══════════════════════════════════════════════
  // RETRY
  // ══════════════════════════════════════════════
  async function handleRetryJob() {
    const res  = await fetch(`/api/jobs/${currentJobId}/retry`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showAlert(data.message, 'success');
      $('btn-retry-job').classList.add('hidden');
      $('btn-pause-job').classList.remove('hidden');
      startPolling();
    } else {
      showAlert(data.error, 'danger');
    }
  }

  // ══════════════════════════════════════════════
  // POLLING — live progress every 3s
  // ══════════════════════════════════════════════
  function startPolling() {
    stopPolling();
    pollInterval = setInterval(pollJob, 3000);
    pollJob(); // immediate first poll
  }

  function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }

  async function pollJob() {
    if (!currentJobId) return;
    try {
      const res  = await fetch(`/api/jobs/${currentJobId}`);
      const data = await res.json();
      if (!data.success) return;

      const job = data.job;
      const total  = job.total_rows   || 0;
      const sent   = job.sent_count   || 0;
      const failed = job.failed_count || 0;
      const done   = sent + failed;
      const pct    = total > 0 ? Math.round((done / total) * 100) : 0;

      $('progress-bar').style.width = pct + '%';
      $('progress-bar').setAttribute('aria-valuenow', pct);
      $('progress-label').textContent = `${done} / ${total}`;
      $('sum-sent').textContent   = sent;
      $('sum-failed').textContent = failed;

      // ETA calculation (2 s per email = default SEND_DELAY_MS)
      const remaining = total - done;
      const etaEl = $('eta-label');
      if (job.status === 'running' && remaining > 0) {
        const etaSec    = Math.ceil((remaining * 2000) / 1000);
        const etaMin    = Math.floor(etaSec / 60);
        const etaRemSec = etaSec % 60;
        etaEl.textContent = etaMin > 0
          ? `~${etaMin}m ${etaRemSec}s remaining`
          : `~${etaSec}s remaining`;
      } else {
        etaEl.textContent = '';
      }

      const statusMap = {
        running:   ['badge-info',      'Running…'],
        paused:    ['badge-warning',   'Paused'],
        completed: ['badge-success',   'Completed'],
        failed:    ['badge-danger',    'Failed'],
        pending:   ['badge-secondary', 'Pending'],
      };
      const [cls, label] = statusMap[job.status] || ['badge-secondary', job.status];
      $('job-status-badge').className   = `badge ${cls}`;
      $('job-status-badge').textContent = label;

      // Update live log table
      if (data.recentLogs) renderLiveLogs(data.recentLogs);

      // Stop polling when terminal state
      if (['completed', 'failed'].includes(job.status)) {
        stopPolling();
        $('btn-pause-job').classList.add('hidden');
        if (job.failed_count > 0) $('btn-retry-job').classList.remove('hidden');

        // Show completion banner
        const isSuccess = job.status === 'completed';
        $('btn-start-job').classList.add('hidden');
        $('progress-section').classList.add('hidden');  // hide bar, replaced by banner
        const banner = $('completion-banner');
        banner.classList.remove('hidden');
        $('completion-msg').textContent = isSuccess
          ? `✓ ${sent} emails sent successfully${ failed > 0 ? ` · ${failed} failed` : ''}. Check Send Logs for details.`
          : `Job failed after ${sent} sent, ${failed} errors. Use Retry to re-send failed rows.`;
        banner.style.background = isSuccess
          ? 'linear-gradient(135deg, #d4efdf 0%, #e8f8ee 100%)'
          : 'linear-gradient(135deg, #fde8e5 0%, #fff5f5 100%)';
        if (!isSuccess) banner.querySelector('h3').textContent = '⚠️ Job Failed';

        // Mark all steps complete
        updateStepper('send', true, true);

        showAlert(`Job ${job.status}. ${sent} sent, ${failed} failed.`, isSuccess ? 'success' : 'warning');
      }

    } catch (err) {
      console.warn('[poll] Error:', err.message);
    }
  }

  function renderLiveLogs(logs) {
    $('live-log-body').innerHTML = logs.map(l => `
      <tr>
        <td>${l.id}</td>
        <td class="cell-truncate">${esc(l.recipient_email)}</td>
        <td class="cell-truncate">${esc(l.subject || '')}</td>
        <td>
          <span class="dot dot-${l.status}"></span>${esc(l.status)}
        </td>
        <td style="white-space:nowrap">${l.sent_at ? fmtDate(l.sent_at) : '—'}</td>
        <td class="cell-truncate" style="color:var(--clr-danger);font-size:12px">${esc(l.error_message || '')}</td>
      </tr>
    `).join('');
  }

  // ══════════════════════════════════════════════
  // VALIDATION
  // ══════════════════════════════════════════════
  function validateCompose() {
    const from    = $('from-address').value.trim();
    const subject = $('subject-tpl').value.trim();
    const body    = quillBody ? quillBody.getText().trim() : '';

    if (!from || !subject || !body) {
      showAlert('Please fill in From Address, Subject, and Body before proceeding.', 'warning');
      return false;
    }
    return true;
  }

  // ══════════════════════════════════════════════
  // UTILITIES
  // ══════════════════════════════════════════════
  function showAlert(msg, type) {
    const el = $('global-alert');
    el.className = `alert alert-${type}`;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.add('hidden'), 6000);
  }

  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ── Boot ──
  init();

})();
