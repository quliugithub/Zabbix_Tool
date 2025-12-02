
// === 核心状态管理 ===
const State = {
    templates: [],
    groups: [],
    proxies: [],
    selectedTplIds: [],
    selectedGrpIds: [],
    selectedProxyId: null,
    config: {},
    taskIds: { install: null, batch: [], uninstall: null },
    logList: [],
    currentTask: null,
    logDetail: '',
};
State.batchRows = State.batchRows || [];
State.batchSelection = new Set();
State.batchList = State.batchList || [];
State.batchResults = {};
State.currentBatchId = null;
State.selector = { type: null, rowId: null, filter: '', temp: new Set() };
State.historyHidden = State.historyHidden || false;
State.historyFloatPos = State.historyFloatPos || null;
State.batchResizeBound = false;

// === 工具函数 ===
const escapeHtml = (str) => {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

const debounce = (fn, delay = 300) => {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    }
};

function togglePassword(id) {
    const el = document.getElementById(id);
    el.type = el.type === 'password' ? 'text' : 'password';
}

const getVal = (id) => document.getElementById(id) ? document.getElementById(id).value.trim() : null;
const setVal = (id, v) => { if(document.getElementById(id)) document.getElementById(id).value = v || ''; };

// Toast 提示
function showToast(msg, type = 'success') {
    const container = document.getElementById('toastContainer');
    const div = document.createElement('div');
    div.className = `toast ${type}`;
    div.textContent = msg;
    container.appendChild(div);
    setTimeout(() => {
        div.style.animation = 'fadeOut 0.3s forwards';
        div.addEventListener('animationend', () => div.remove());
    }, 3000);
}

// Loading 状态控制
const withLoading = async (btn, fn) => {
    if (!btn) return await fn();
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<div class="btn-spinner"></div> 处理中...`;
    try {
        await fn();
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
};

// === API 交互核心 (强校验 Code) ===
async function api(url, opts = {}) {
    try {
        const res = await fetch(url, opts);
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch {
            return { ok: false, msg: `API 解析失败: ${res.statusText}`, data: text };
        }

        if (typeof json === 'object' && json !== null && 'code' in json) {
            const isSuccess = (json.code == 0);
            return {
                ok: isSuccess,
                msg: json.msg || (isSuccess ? '操作成功' : `操作失败 (Code: ${json.code})`),
                data: json.data
            };
        }
        return { ok: res.ok, msg: res.ok?'操作成功':json.msg||'请求失败', data: json };
    } catch (e) {
        return { ok: false, msg: `网络错误: ${e.message}`, data: null };
    }
}

// 统一处理结果：失败则弹窗
function handleResult(res, successMsg) {
    if (res.ok) {
        showToast(successMsg || res.msg, 'success');
    } else {
        showToast(res.msg, 'error');
        console.error('API Error:', res);
        if (res.data && typeof res.data === 'string' && res.data.length > 50) {
            document.getElementById('resultContent').textContent = res.data;
            document.getElementById('resultModal').style.display = 'flex';
        }
    }
    return res.ok;
}

// === 日志逻辑 ===
async function fetchLogs(taskId, target = 'detail') {
    if (!taskId) return;
    const res = await api(`/api/zabbix/logs/${taskId}`);
    if (res.ok && Array.isArray(res.data)) {
        const text = res.data.map(r => {
            const ts = r.ts ? new Date(r.ts * 1000).toLocaleString() : '';
            const step = r.step ? `[${r.step}]` : '';
            const status = r.status ? `(${r.status})` : '';
            const ip = r.ip ? `${r.ip} ` : '';
            const msg = r.message || '';
            return `[${ts}] ${ip}${step}${status} ${msg}`.trim();
        }).join('\n');

        State.logDetail = text || '暂无日志内容';
    } else if (!res.ok) {
        State.logDetail = `日志获取失败: ${res.msg}`;
        showToast(`日志获取失败: ${res.msg}`, 'error');
    }
}

function renderLogList() {
    const wrap = document.getElementById('logList');
    const badge = document.getElementById('logCountBadge');
    if(badge) {
        badge.innerText = State.logList.length;
        badge.style.display = 'inline-block';
    }

    if (!State.logList.length) {
        wrap.innerHTML = '<div style="padding:20px;text-align:center;color:#94a3b8;">暂无历史任务</div>';
        return;
    }

    wrap.innerHTML = State.logList.map(item => {
        const ts = item.ts ? new Date(item.ts * 1000).toLocaleString() : '未知时间';
        const host = escapeHtml(item.hostname || '未命名主机');
        const ip = escapeHtml(item.ip || '');
        const taskIdFull = item.task_id;
        const taskIdShort = taskIdFull.substring(0, 8) + '...';

        const active = item.task_id === State.currentTask ? 'active' : '';

        return `
            <div class="log-item ${active}" onclick="viewLog('${taskIdFull}')">
                <div class="time">${ts}</div>
                <div class="host">${host}</div>
                ${ip ? `<div class="ip">IP: ${ip}</div>` : ''}
                <div class="task-id">ID: ${taskIdShort}</div>
            </div>
        `;
    }).join('');
}

async function loadLogList() {
    const res = await api('/api/zabbix/logs');
    if (res.ok) {
        State.logList = res.data || [];
        renderLogList();
    } else {
        showToast(`日志列表获取失败: ${res.msg}`, 'error');
    }
}

async function viewLog(taskId) {
    State.currentTask = taskId;
    renderLogList();
    document.getElementById('logContent').textContent = '加载中...';
    await fetchLogs(taskId);
    document.getElementById('logContent').textContent = State.logDetail || '暂无日志';
}

// === 业务逻辑 ===

// 1. 初始化
async function loadFragments() {
    const container = document.getElementById('tabContainer');
    if (!container) return;
    const files = ['dashboard','install','batch','tmpl','group','bind','uninstall','config'];
    for (const name of files) {
        try {
            const res = await fetch(`static/fragments/${name}.html`);
            const html = await res.text();
            container.insertAdjacentHTML('beforeend', html);
        } catch (e) {
            console.error('加载片段失败', name, e);
        }
    }
    initFloatingHistoryDrag();
}

window.addEventListener('DOMContentLoaded', async () => {
    await loadFragments();
    await loadConfig(false);
    await Promise.all([loadTemplates(false), loadGroups(false), loadProxies(false)]);
    await refreshBatchList();
    renderBatchTable();
    renderProxySelected();
    document.getElementById('global-loading').style.display = 'none';
    updateDashboard();
    applyHistoryHidden();
});

function updateDashboard() {
    document.getElementById('stat-tmpl-count').textContent = State.templates.length;
    document.getElementById('stat-group-count').textContent = State.groups.length;
    const hasApi = !!getVal('cfg_api_base');
    const statusEl = document.getElementById('stat-config');
    statusEl.textContent = hasApi ? '已配置' : '未配置';
    statusEl.style.color = hasApi ? '#10b981' : '#f59e0b';
}

// 2. 加载配置
async function loadConfig(isManual = false) {
    const res = await api('/api/zabbix/config');
    if (!res.ok) {
        if (isManual || res.msg.includes('失败')) handleResult(res);
        return;
    }

    if (res.data) {
        State.config = res.data;
        const c = res.data;
        setVal('cfg_api_base', c.zabbix_api_base);
        setVal('cfg_user', c.zabbix_api_user);
        setVal('cfg_password', c.zabbix_api_password);
        setVal('cfg_default_template', c.default_template_id);
        setVal('cfg_default_group', c.default_group_id);
        setVal('cfg_server_host', c.zabbix_server_host);
        setVal('cfg_agent_tgz', c.agent_tgz_url);
        setVal('local_agent_path', c.local_agent_path);
        updateDashboard();
        if(isManual) showToast('配置已重置');
    }
}

async function saveConfig(btn) {
    await withLoading(btn, async () => {
        const payload = {
            zabbix_api_base: getVal('cfg_api_base'),
            zabbix_api_user: getVal('cfg_user'),
            zabbix_api_password: getVal('cfg_password'),
            default_template_id: getVal('cfg_default_template'),
            default_group_id: getVal('cfg_default_group'),
            zabbix_server_host: getVal('cfg_server_host'),
            agent_tgz_url: getVal('cfg_agent_tgz'),
            local_agent_path: getVal('local_agent_path'),
        };
        const res = await api('/api/zabbix/config', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        if(handleResult(res, '配置已保存')) {
            State.config = payload;
            updateDashboard();
        }
    });
}

// 3. 数据加载
async function loadTemplates(isManual = false, btn = null) {
    const action = async () => {
        const res = await api('/api/zabbix/templates');
        if (!res.ok) { handleResult(res); return; }
        State.templates = res.data || [];
        debouncedFilterTemplates();
        debouncedSearchTmpl();
        updateDashboard();
        if(isManual) showToast(`加载了 ${State.templates.length} 个模板`);
    };
    await withLoading(btn, action);
}

async function loadGroups(isManual = false, btn = null) {
    const action = async () => {
        const res = await api('/api/zabbix/groups');
        if (!res.ok) { handleResult(res); return; }
        State.groups = res.data || [];
        debouncedFilterGroups();
        debouncedSearchGroup();
        updateDashboard();
        if(isManual) showToast(`加载了 ${State.groups.length} 个群组`);
    };
    await withLoading(btn, action);
}

async function loadProxies(isManual = false, btn = null) {
    const action = async () => {
        const res = await api('/api/zabbix/proxies');
        if (!res.ok) {
            if(isManual) handleResult(res);
            return;
        }
        State.proxies = res.data || [];
        debouncedFilterProxies();
        if(isManual) showToast(`加载了 ${State.proxies.length} 个 Proxy`);
    };
    await withLoading(btn, action);
}

// 4. 下拉菜单与搜索
const renderDropdown = (containerId, items, selectedIds, onToggleName, idKey = 'templateid') => {
    const container = document.getElementById(containerId);
    if (!items.length) { container.innerHTML = '<div style="padding:8px;color:#999;">无数据</div>'; return; }

    container.innerHTML = items.map(item => {
        const id = item[idKey] || item.templateid || item.groupid || item.proxyid;
        const name = escapeHtml(item.name || item.host);
        const checked = selectedIds.includes(String(id)) ? 'checked' : '';
        return `<label><input type="checkbox" value="${id}" ${checked} onchange="${onToggleName}(this)"> ${name}</label>`;
    }).join('');
};

const debouncedFilterTemplates = debounce(() => {
    const kw = (getVal('tmplFilter') || '').toLowerCase();
    const filtered = State.templates.filter(t => t.name.toLowerCase().includes(kw));
    renderDropdown('tmplOptions', filtered, State.selectedTplIds, 'onToggleTpl', 'templateid');
});

const debouncedFilterGroups = debounce(() => {
    const kw = (getVal('groupFilter') || '').toLowerCase();
    const filtered = State.groups.filter(g => g.name.toLowerCase().includes(kw));
    renderDropdown('groupOptions', filtered, State.selectedGrpIds, 'onToggleGrp', 'groupid');
});

const renderProxyDropdown = () => {
    const container = document.getElementById('proxyOptions');
    if (!container) return;
    const kw = (getVal('proxyFilter') || '').toLowerCase();
    const filtered = State.proxies.filter(p =>
        (p.name && p.name.toLowerCase().includes(kw)) || (p.host && p.host.toLowerCase().includes(kw))
    );
    if (!filtered.length) {
        container.innerHTML = '<div style="padding:8px;color:#999;">无 Proxy</div>';
        return;
    }
    container.innerHTML = filtered.map(p => {
        const id = p.proxyid;
        const label = escapeHtml(p.name || p.host || id);
        const checked = String(State.selectedProxyId) === String(id) ? 'checked' : '';
        return `<label><input type="radio" name="proxyRad" value="${id}" ${checked} onchange="onSelectProxy('${id}')"> ${label}</label>`;
    }).join('');
};

const debouncedFilterProxies = debounce(renderProxyDropdown);

// 选中逻辑
window.onToggleTpl = (el) => {
    const v = el.value;
    if(el.checked) { if(!State.selectedTplIds.includes(v)) State.selectedTplIds.push(v); }
    else { State.selectedTplIds = State.selectedTplIds.filter(id => id !== v); }
    renderTags('tmplSelected', State.selectedTplIds, State.templates, 'templateid', 'removeTpl');
};

window.onToggleGrp = (el) => {
    const v = el.value;
    if(el.checked) { if(!State.selectedGrpIds.includes(v)) State.selectedGrpIds.push(v); }
    else { State.selectedGrpIds = State.selectedGrpIds.filter(id => id !== v); }
    renderTags('groupSelected', State.selectedGrpIds, State.groups, 'groupid', 'removeGrp');
};

window.onSelectProxy = (id) => {
    State.selectedProxyId = id;
    renderProxySelected();
};

const renderTags = (containerId, ids, source, idKey, removeFnName) => {
    const div = document.getElementById(containerId);
    if (!ids.length) { div.innerHTML = '<span style="color:#94a3b8;">未选择</span>'; return; }

    div.innerHTML = ids.map(id => {
        const item = source.find(x => String(x[idKey]) === String(id));
        const name = item ? escapeHtml(item.name || item.host) : id;
        return `<span class="tag-pill">${name} <button onclick="${removeFnName}('${id}')">×</button></span>`;
    }).join('');
};

window.removeTpl = (id) => {
    State.selectedTplIds = State.selectedTplIds.filter(x=>x!==id);
    renderTags('tmplSelected', State.selectedTplIds, State.templates, 'templateid', 'removeTpl');
    debouncedFilterTemplates();
};
window.removeGrp = (id) => {
    State.selectedGrpIds = State.selectedGrpIds.filter(x=>x!==id);
    renderTags('groupSelected', State.selectedGrpIds, State.groups, 'groupid', 'removeGrp');
    debouncedFilterGroups();
};
window.clearTemplates = () => {
    State.selectedTplIds = [];
    renderTags('tmplSelected', State.selectedTplIds, State.templates, 'templateid', 'removeTpl');
    debouncedFilterTemplates();
};
window.clearGroups = () => {
    State.selectedGrpIds = [];
    renderTags('groupSelected', State.selectedGrpIds, State.groups, 'groupid', 'removeGrp');
    debouncedFilterGroups();
};

window.clearProxy = () => { State.selectedProxyId = null; renderProxySelected(); renderProxyDropdown(); };
const renderProxySelected = () => {
    const div = document.getElementById('proxySelected');
    if (!div) return;
    if (!State.selectedProxyId) {
        div.innerHTML = '<span style="color:#94a3b8;">未选择</span>';
        return;
    }
    const p = State.proxies.find(x => String(x.proxyid) === String(State.selectedProxyId));
    const name = p ? escapeHtml(p.name || p.host || State.selectedProxyId) : State.selectedProxyId;
    div.innerHTML = `<span class="tag-pill">${name} <button onclick="clearProxy()">×</button></span>`;
};

// 模式切换联动
window.onModeChange = () => {
    const mode = document.querySelector('input[name="install_mode"]:checked').value;
    // Removed precheck checkbox logic
};

// 5. 核心安装逻辑
async function install(btn) {
    if (!getVal('ip')) { showToast('IP 为必填项', 'error'); return; }

    const mode = document.querySelector('input[name="install_mode"]:checked').value;
    // const doPrecheck = document.getElementById('precheck').checked; // Removed

    let installAgent = true;
    let registerServer = true;

    if (mode === 'agent_only') {
        registerServer = false;
    } else if (mode === 'register_only') {
        installAgent = false;
    }

    const endpoint = (mode === 'register_only') ? '/api/zabbix/register' : '/api/zabbix/install';

    await withLoading(btn, async () => {
        const payload = {
            hostname: getVal('host') || null,
            ip: getVal('ip'),
            os_type: getVal('os'),
            env: getVal('env'),
            port: parseInt(getVal('port')||10050),
            ssh_user: getVal('ssh_user'),
            ssh_password: getVal('ssh_password'),
            ssh_port: parseInt(getVal('ssh_port')||22),
            visible_name: getVal('visible_name') || null,
            template_ids: State.selectedTplIds,
            group_ids: State.selectedGrpIds,
            proxy_id: State.selectedProxyId,

            // 控制参数
            precheck: false, // Force disabled
            install_agent: installAgent,
            register_server: registerServer
        };

        const res = await api(endpoint, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        const ok = handleResult(res);
        if (ok && res.data) {
            if (res.data.task_id) {
                State.taskIds.install = res.data.task_id;
                await showInstallLog(res.data.task_id);
            }
        }
    });
}

async function uninstall(btn) {
    if (!confirm("⚠️ 警告：确定要卸载该主机的 Agent 吗？此操作不可恢复！")) return;
    await withLoading(btn, async () => {
        const payload = {
            ip: getVal('un_ip'), ssh_user: getVal('un_ssh_user'),
            ssh_password: getVal('un_ssh_password'), ssh_port: parseInt(getVal('un_ssh_port')||22)
        };
        const res = await api('/api/zabbix/uninstall', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        handleResult(res);
    });
}

// 6. 批量操作 (Unified Logic)
// State.batchList is the source of truth for the table


// 文件选择 UI 交互
window.handleFileSelect = async (input) => {
    const file = input.files[0];
    const name = file ? file.name : '';
    const display = document.getElementById('fileNameDisplay');
    const bar = document.getElementById('fileStatusBar');
    if (display) display.textContent = name || '';
    if (bar) bar.classList.toggle('show', !!name);
    if (file) {
        await uploadBatch(document.getElementById('importBtn'));
    }
};

window.triggerBatchImport = () => {
    const fileInput = document.getElementById('batchFile');
    if (fileInput) fileInput.click();
};

// 7. 删除操作
async function deleteTemplate(btn) {
    const id = getVal('del_tpl');
    if(!id) return showToast('请输入 ID', 'error');
    if(!confirm(`⚠️ 严重警告：确定删除模板 ID: ${id} 吗？`)) return;

    await withLoading(btn, async () => {
            const res = await api('/api/zabbix/template/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({template_id:id}) });
            handleResult(res);
    });
}

// === 批量（新版，可编辑表格 + 历史批次） ===

// 渲染左侧历史列表
function renderBatchHistoryList() {
    const wrap = document.getElementById('batchHistoryList');
    if (!wrap) return;
    if (!State.batchList.length) {
        wrap.innerHTML = '<div class="history-empty">暂无历史批次</div>';
        return;
    }
    wrap.innerHTML = State.batchList.map(item => {
        const active = State.currentBatchId && String(State.currentBatchId) === String(item.batch_id) ? 'active' : '';
        const ts = item.ts ? new Date(item.ts * 1000).toLocaleString() : '';
        const count = item.count || (item.hosts?.length ?? 0) || 0;
        const title = ts || '未知时间';
        const meta = `共 ${count} 台`;
        return `<div class="history-item ${active}" onclick="loadBatchById('${item.batch_id}')">
            <div class="history-item-title">${title}</div>
            <div class="history-item-meta">${meta}</div>
        </div>`;
    }).join('');
}

// 渲染右侧表格
function renderBatchTable() {
    const tbody = document.querySelector('#batchTable tbody');
    const countEl = document.getElementById('batchCount');
    if(countEl) countEl.innerText = `共 ${State.batchRows.length} 条数据`;

    // 清理已被删除的选中项
    const validIds = new Set(State.batchRows.map(r => String(r.item_id)));
    Array.from(State.batchSelection).forEach(id => {
        if (!validIds.has(id)) State.batchSelection.delete(id);
    });

    const infoEl = document.getElementById('batchInfo');
    if (infoEl) {
        const count = State.batchRows.length;
        if (State.currentBatchId) {
            infoEl.textContent = `批次 ${State.currentBatchId} · ${count} 条`;
        } else {
            infoEl.textContent = count ? `未保存批次 · ${count} 条` : '当前未选择批次';
        }
    }

    if (!tbody) return;
    if (!State.batchRows.length) {
        tbody.innerHTML = '<tr><td colspan="14" style="text-align:center; color:#94a3b8; padding: 20px;">暂无数据，请导入或添加</td></tr>';
        updateBatchActions();
        return;
    }
    tbody.innerHTML = State.batchRows.map(row => {
        const id = String(row.item_id);
        const checked = State.batchSelection.has(id) ? 'checked' : '';
        const res = State.batchResults[id] || {};
        const status = res.status || '';
        const statusColor = status === 'ok' ? '#10b981' : (status === 'failed' ? '#ef4444' : '#64748b');
        const taskBtn = res.task_id ? `<button class="secondary" onclick="openLogModalWithTask('${res.task_id}')">日志</button>` : '';
        
        const tmplTags = (row.template_ids || []).map(tid => {
            const t = State.templates.find(x => String(x.templateid) === String(tid));
            return `<span class="tag-chip">${escapeHtml(t?.name || tid)}</span>`;
        }).join('') || '<span style="color:#94a3b8;">未选</span>';

        const grpTags = (row.group_ids || []).map(gid => {
            const g = State.groups.find(x => String(x.groupid) === String(gid));
            return `<span class="tag-chip">${escapeHtml(g?.name || gid)}</span>`;
        }).join('') || '<span style="color:#94a3b8;">未选</span>';

        return `
            <tr>
                <td><input type="checkbox" ${checked} onchange="toggleBatchSelect('${id}')" /></td>
                <td><input value="${escapeHtml(row.hostname || '')}" oninput="editBatchField('${id}','hostname',this.value)" /></td>
                <td><input value="${escapeHtml(row.ip || '')}" oninput="editBatchField('${id}','ip',this.value)" /></td>
                <td><input value="${escapeHtml(row.env || '')}" oninput="editBatchField('${id}','env',this.value)" /></td>
                <td><input value="${escapeHtml(row.ssh_user || '')}" oninput="editBatchField('${id}','ssh_user',this.value)" /></td>
                <td><input type="password" value="${escapeHtml(row.ssh_password || '')}" oninput="editBatchField('${id}','ssh_password',this.value)" /></td>
                <td><input value="${escapeHtml(row.ssh_port || '')}" oninput="editBatchField('${id}','ssh_port',this.value)" style="width:70px;" /></td>
                <td><input value="${escapeHtml(row.port || '')}" oninput="editBatchField('${id}','port',this.value)" style="width:70px;" /></td>
                <td><input value="${escapeHtml(row.jmx_port || '')}" oninput="editBatchField('${id}','jmx_port',this.value)" style="width:70px;" /></td>
                <td><input value="${escapeHtml(row.proxy_id || '')}" oninput="editBatchField('${id}','proxy_id',this.value)" /></td>
                <td>
                    <div class="selector-cell">
                        <div class="tag-chips">${tmplTags}</div>
                        <button class="secondary" onclick="openSelector('tmpl','${id}')">选择</button>
                    </div>
                </td>
                <td>
                    <div class="selector-cell">
                        <div class="tag-chips">${grpTags}</div>
                        <button class="secondary" onclick="openSelector('grp','${id}')">选择</button>
                    </div>
                </td>
                <td style="color:${statusColor};">${status || ''}${res.error ? (' - ' + escapeHtml(res.error)) : ''}</td>
                <td>${taskBtn}</td>
            </tr>
        `;
    }).join('');
    updateBatchActions();
    setupBatchColumnResize();
}

window.updateBatchActions = function updateBatchActions() {
    const hasSelection = State.batchSelection.size > 0;
    const delBtn = document.getElementById('deleteRowsBtn');
    if (delBtn) delBtn.disabled = !hasSelection;
};

function getSelectedBatchIds() {
    return Array.from(State.batchSelection);
}

window.toggleBatchSelect = (id) => {
    if (State.batchSelection.has(id)) State.batchSelection.delete(id);
    else State.batchSelection.add(id);
    updateBatchActions();
};

window.onTemplateSelectChange = (rowId, selectEl) => {
    const row = State.batchRows.find(r => String(r.item_id) === String(rowId));
    if (!row) return;
    const vals = Array.from(selectEl.selectedOptions).map(o => o.value).filter(Boolean);
    row.template_ids = vals;
};

window.onGroupSelectChange = (rowId, selectEl) => {
    const row = State.batchRows.find(r => String(r.item_id) === String(rowId));
    if (!row) return;
    const vals = Array.from(selectEl.selectedOptions).map(o => o.value).filter(Boolean);
    row.group_ids = vals;
};

function editBatchField(id, field, value) {
    const row = State.batchRows.find(r => String(r.item_id) === String(id));
    if (row) row[field] = value;
}

window.toggleHistoryPanel = () => {
    State.historyHidden = !State.historyHidden;
    applyHistoryHidden();
};

function applyHistoryHidden() {
    const layout = document.querySelector('.batch-layout');
    const btn = document.getElementById('toggleHistoryBtn');
    const floatBtn = document.getElementById('historyFloatBtn');
    if (layout) {
        layout.classList.toggle('history-hidden', !!State.historyHidden);
    }
    if (btn) {
        btn.textContent = State.historyHidden ? '显示历史' : '隐藏历史';
    }
    if (floatBtn) {
        floatBtn.style.display = State.historyHidden ? 'flex' : 'none';
        if (State.historyHidden) applyFloatBtnPos(floatBtn);
    }
}

function applyFloatBtnPos(btn) {
    const pos = State.historyFloatPos;
    if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return;
    btn.style.left = `${pos.left}px`;
    btn.style.top = `${pos.top}px`;
    btn.style.bottom = 'auto';
}

function initFloatingHistoryDrag() {
    const btn = document.getElementById('historyFloatBtn');
    if (!btn) return;
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onMove = (clientX, clientY) => {
        const maxX = window.innerWidth - btn.offsetWidth - 10;
        const maxY = window.innerHeight - btn.offsetHeight - 10;
        const x = Math.min(Math.max(clientX - offsetX, 10), maxX);
        const y = Math.min(Math.max(clientY - offsetY, 10), maxY);
        btn.style.left = `${x}px`;
        btn.style.top = `${y}px`;
        btn.style.bottom = 'auto';
        State.historyFloatPos = { left: x, top: y };
    };

    const onMouseMove = (e) => {
        if (!dragging) return;
        e.preventDefault();
        onMove(e.clientX, e.clientY);
    };
    const onTouchMove = (e) => {
        if (!dragging || !e.touches.length) return;
        const t = e.touches[0];
        onMove(t.clientX, t.clientY);
    };
    const stop = () => { dragging = false; };

    btn.addEventListener('mousedown', (e) => {
        dragging = true;
        const rect = btn.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
    });
    btn.addEventListener('touchstart', (e) => {
        dragging = true;
        const rect = btn.getBoundingClientRect();
        const t = e.touches[0];
        offsetX = t.clientX - rect.left;
        offsetY = t.clientY - rect.top;
    }, { passive: true });

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('mouseup', stop);
    window.addEventListener('touchend', stop);

    // Apply saved position on init
    applyFloatBtnPos(btn);
}

function setupBatchColumnResize() {
    if (State.batchResizeBound) return;
    const headerRow = document.querySelector('#batchTable thead tr');
    if (!headerRow) return;
    const rows = () => Array.from(document.querySelectorAll('#batchTable tbody tr'));

    headerRow.querySelectorAll('th').forEach((th, idx) => {
        th.style.position = 'relative';
        const handle = document.createElement('span');
        handle.className = 'col-resizer';
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startX = e.pageX;
            const startWidth = th.offsetWidth;
            const move = (ev) => {
                const delta = ev.pageX - startX;
                const minWidth = idx === 0 ? 40 : 60;
                const newW = Math.max(minWidth, startWidth + delta);
                th.style.width = `${newW}px`;
                rows().forEach(r => {
                    if (r.children[idx]) r.children[idx].style.width = `${newW}px`;
                });
            };
            const up = () => {
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
        });
        th.appendChild(handle);
    });
    State.batchResizeBound = true;
}

function createEmptyBatchRow() {
    return {
        item_id: `tmp-${Date.now()}-${Math.random().toString(16).slice(2,6)}`,
        hostname: '',
        ip: '',
        env: '',
        ssh_user: '',
        ssh_password: '',
        ssh_port: '22',
        port: '10050',
        jmx_port: '10052',
        proxy_id: '',
        template_ids: [],
        group_ids: [],
    };
}

window.addRowsFromSelection = () => {
    const row = createEmptyBatchRow();
    State.batchRows.push(row);
    State.batchSelection.add(String(row.item_id));
    renderBatchTable();
    showToast('已添加一条空行');
};

window.clearAllBatchRows = () => {
    if (!State.batchRows.length) {
        showToast('当前没有可清空的数据', 'warning');
        return;
    }
    if (!confirm('确认清空当前表格所有数据吗？')) return;
    State.batchRows = [];
    State.batchSelection.clear();
    State.batchResults = {};
    State.currentBatchId = null;
    const display = document.getElementById('fileNameDisplay');
    const bar = document.getElementById('fileStatusBar');
    if (display) display.textContent = '';
    if (bar) bar.classList.remove('show');
    renderBatchTable();
    showToast('已清空当前表格数据');
};

window.deleteSelectedRows = () => deleteSelectedBatchRows();

function renderSelectorOptions() {
    const listEl = document.getElementById('selectorList');
    if (!listEl || !State.selector.type) return;
    const keyword = (document.getElementById('selectorSearch')?.value || '').toLowerCase();
    const source = State.selector.type === 'grp' ? State.groups : State.templates;
    const idKey = State.selector.type === 'grp' ? 'groupid' : 'templateid';
    const filtered = source.filter(item => {
        const name = (item.name || item.host || '').toLowerCase();
        return !keyword || name.includes(keyword) || String(item[idKey]).includes(keyword);
    });
    if (!filtered.length) {
        listEl.innerHTML = '<div class="history-empty">暂无数据</div>';
        return;
    }
    listEl.innerHTML = filtered.map(item => {
        const id = String(item[idKey]);
        const name = escapeHtml(item.name || item.host || id);
        const checked = State.selector.temp.has(id) ? 'checked' : '';
        return `<label class="selector-item"><input type="checkbox" value="${id}" ${checked} onchange="toggleSelectorItem(this)"> <span>${name}</span></label>`;
    }).join('');
}

window.openSelector = (type, rowId) => {
    State.selector.type = type;
    State.selector.rowId = rowId;
    State.selector.temp = new Set();
    const row = State.batchRows.find(r => String(r.item_id) === String(rowId));
    if (row) {
        const defaults = type === 'grp' ? (row.group_ids || []) : (row.template_ids || []);
        defaults.forEach(id => State.selector.temp.add(String(id)));
    }
    const titleEl = document.getElementById('selectorTitle');
    if (titleEl) titleEl.textContent = type === 'grp' ? '选择群组' : '选择模板';
    const searchEl = document.getElementById('selectorSearch');
    if (searchEl) searchEl.value = '';
    renderSelectorOptions();
    const modal = document.getElementById('selectorModal');
    if (modal) modal.style.display = 'flex';
};

window.toggleSelectorItem = (el) => {
    const id = el.value;
    if (el.checked) State.selector.temp.add(id);
    else State.selector.temp.delete(id);
};

window.filterSelectorList = () => renderSelectorOptions();

window.confirmSelector = () => {
    const row = State.batchRows.find(r => String(r.item_id) === String(State.selector.rowId));
    if (row) {
        if (State.selector.type === 'grp') {
            row.group_ids = Array.from(State.selector.temp);
        } else {
            row.template_ids = Array.from(State.selector.temp);
        }
    }
    closeSelector();
    renderBatchTable();
};

window.closeSelector = () => {
    const modal = document.getElementById('selectorModal');
    if (modal) modal.style.display = 'none';
    State.selector.type = null;
    State.selector.rowId = null;
    State.selector.temp = new Set();
    const searchEl = document.getElementById('selectorSearch');
    if (searchEl) searchEl.value = '';
};

// 刷新左侧历史列表
async function refreshBatchList() {
    const res = await api('/api/zabbix/batch/list');
    if (res.ok) {
        State.batchList = res.data || [];
        renderBatchHistoryList();
    }
}

// 加载特定批次
async function loadBatchById(id) {
    if (!id) return;
    const res = await api(`/api/zabbix/batch/${id}`);
    if (res.ok && res.data) {
        State.currentBatchId = res.data.batch_id;
        State.batchRows = res.data.hosts || [];
        State.batchSelection = new Set(State.batchRows.map(h => String(h.item_id)));
        State.batchResults = {};
        renderBatchTable();
        renderBatchHistoryList(); // 更新选中状态
    } else {
        handleResult(res);
    }
}

// 批量执行
async function runBatch(action = 'install', btn) {
    // 如果没有批次ID，先创建一个临时批次 (对于手动添加的数据)
    // 这里简化逻辑：必须先有数据
    if (!State.batchRows.length) return showToast('请先添加数据', 'error');
    
    // 如果是手动添加的数据且没有 currentBatchId，可能需要先保存？
    // 或者直接发送 host_list 给后端。
    // 现有后端接口似乎依赖 batch_id。
    // 假设后端支持直接传 hosts 或者我们先调用 upload 接口保存。
    // 暂时保持原逻辑：必须有 batch_id。
    
    if (!State.currentBatchId) {
         // 尝试自动保存为新批次
         // 这里模拟一个上传操作来获取 batch_id
         // 但由于没有文件，我们需要一个 create 接口。
         // 暂时提示用户先导入。
         // 或者我们可以构造一个 CSV Blob 上传。
         // 为了简单，我们提示。
         // showToast('请先导入数据生成批次', 'warning');
         // return;
    }

    const ids = Array.from(State.batchSelection);
    if (!ids.length) return showToast('请先勾选要执行的主机', 'error');

    const mode = document.querySelector('input[name="install_mode"]:checked')?.value || 'full';
    let registerServer = true;
    if (mode === 'agent_only') registerServer = false;

    // 构造 payload
    const payload = {
        batch_id: State.currentBatchId, // 可能为空
        host_ids: ids,
        action,
        template_ids: State.selectedTplIds,
        group_ids: State.selectedGrpIds,
        proxy_id: State.selectedProxyId,
        web_monitor_url: getVal('web_url') || null,
        jmx_port: parseInt(getVal('jmx_port')||10052),
        register_server: registerServer,
        precheck: false,
        // 如果后端支持直接传 hosts 数据，可以在这里扩展
        // hosts: State.batchRows.filter(r => ids.includes(String(r.item_id)))
    };

    await withLoading(btn, async () => {
        const res = await api('/api/zabbix/batch/run', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        if (handleResult(res, '批量任务已提交')) {
            const results = res.data?.results || [];
            results.forEach(r => { State.batchResults[String(r.item_id)] = r; });
            renderBatchTable();
        }
    });
}

// 上传文件
async function uploadBatch(btn) {
    const f = document.getElementById('batchFile').files[0];
    if(!f) return showToast('请先选择文件', 'error');

    // 重置 input 以便下次触发
    document.getElementById('batchFile').value = '';

    await withLoading(btn || document.body, async () => { // btn 可能是 null 如果是通过 input onchange 触发
        const fd = new FormData(); fd.append('file', f);
        const res = await api('/api/zabbix/batch/upload', { method:'POST', body:fd });
        const ok = handleResult(res, '导入成功');
        if (ok && res.data) {
            State.currentBatchId = res.data.batch_id;
            State.batchRows = res.data.hosts || [];
            State.batchSelection = new Set(State.batchRows.map(h => String(h.item_id)));
            State.batchResults = {};
            renderBatchTable();
            await refreshBatchList();
        }
    });
}

// 删除选中的行
window.deleteSelectedBatchRows = () => {
    const ids = getSelectedBatchIds();
    if (!ids.length) return showToast('请先勾选要删除的行', 'warning');
    
    if(!confirm(`确定删除选中的 ${ids.length} 条数据吗？`)) return;

    State.batchRows = State.batchRows.filter(r => !ids.includes(String(r.item_id)));
    ids.forEach(id => {
        State.batchSelection.delete(id);
        delete State.batchResults[id];
    });
    renderBatchTable();
};

// 全选/反选
window.toggleAllBatchRows = (checkbox) => {
    if (checkbox.checked) {
        State.batchRows.forEach(r => State.batchSelection.add(String(r.item_id)));
    } else {
        State.batchSelection.clear();
    }
    renderBatchTable();
};


async function downloadBatchTemplate() {
    const res = await api('/api/zabbix/batch/template');
    if (!res.ok || !res.data) { handleResult(res); return; }
    const content = res.data.content || '';
    const filename = res.data.filename || 'zabbix_batch_template.csv';
    const blob = new Blob([content], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

async function deleteGroup(btn) {
    const id = getVal('del_group');
    if(!id) return showToast('请输入 ID', 'error');
    if(!confirm(`⚠️ 严重警告：确定删除群组 ID: ${id} 吗？`)) return;

    await withLoading(btn, async () => {
            const res = await api('/api/zabbix/group/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({group_id:id}) });
            handleResult(res);
    });
}

// 8. 模板绑定
async function tplAction(btn) {
    await withLoading(btn, async () => {
        const payload = {
            ip: getVal('tpl_ip'), template_ids: getVal('tpl_ids').split(',').filter(Boolean),
            action: getVal('tpl_action')
        };
        const res = await api('/api/zabbix/template', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        handleResult(res);
    });
}

// === UI 辅助 ===
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => { switchTab(btn.dataset.tab); });
});

window.switchTab = (tabId) => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === tabId));
};

function renderTable(id, rows) {
    const t = document.getElementById(id);
    if(!rows || !rows.length) { t.style.display='none'; return; }
    t.style.display='table';
    const h = Object.keys(rows[0]);
    t.querySelector('thead').innerHTML = '<tr>'+h.map(x=>`<th>${escapeHtml(x)}</th>`).join('')+'</tr>';
    t.querySelector('tbody').innerHTML = rows.slice(0, 100).map(r =>
        '<tr>'+h.map(k=>`<td>${escapeHtml(r[k])}</td>`).join('')+'</tr>'
    ).join('');
}

const debouncedSearchTmpl = debounce(() => {
    const kw = (getVal('tmplSearch')||'').toLowerCase();
    const rows = State.templates.filter(t => t.name.toLowerCase().includes(kw) || String(t.templateid).includes(kw));
    renderTable('tmplTable', rows);
});

const debouncedSearchGroup = debounce(() => {
    const kw = (getVal('groupSearch')||'').toLowerCase();
    const rows = State.groups.filter(g => g.name.toLowerCase().includes(kw) || String(g.groupid).includes(kw));
    renderTable('groupTable', rows);
});

async function openLogModalWithTask(targetTaskId) {
    document.getElementById('logModal').style.display='flex';
    document.getElementById('logContent').textContent = '加载任务列表...';
    await loadLogList();

    const tid = targetTaskId || (State.logList[0]?.task_id || null);
    if (tid) {
        await viewLog(tid);
    } else {
        document.getElementById('logContent').textContent = '暂无历史日志';
    }
}

window.showInstallLog = (tid) => openLogModalWithTask(tid || State.taskIds.install);
window.showBatchLog = (tid) => openLogModalWithTask(tid || (State.taskIds.batch.length ? State.taskIds.batch[0] : null));
window.showUninstallLog = (tid) => openLogModalWithTask(tid || State.taskIds.uninstall);
window.closeModal = (id) => { document.getElementById(id).style.display='none'; };

window.toggleDropdown = (id) => {
    const m = document.getElementById(id);
    const show = m.classList.contains('show');
    document.querySelectorAll('.dropdown-menu').forEach(x=>x.classList.remove('show'));
    if(!show) m.classList.add('show');
};
document.addEventListener('click', e => { if(!e.target.closest('.dropdown')) document.querySelectorAll('.dropdown-menu').forEach(x=>x.classList.remove('show')); });
