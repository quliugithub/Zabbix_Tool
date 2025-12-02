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
    batchList: [],
    batchRows: [],
    currentBatchId: null,
    batchSelection: new Set(),
    batchResults: {},
};

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
window.addEventListener('DOMContentLoaded', async () => {
    await loadConfig(false);
    await Promise.all([loadTemplates(false), loadGroups(false), loadProxies(false)]);
    await refreshBatchList();
    renderProxySelected();
    renderBatchTable();
    document.getElementById('global-loading').style.display = 'none';
    updateDashboard();
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
        setVal('cfg_version', c.zabbix_version);
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
            zabbix_version: getVal('cfg_version'),
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
        return `<span class="tag-pill">${name} <button onclick="${removeFnName}('${id}')">&times;</button></span>`;
    }).join('');
};

window.removeTpl = (id) => {
    State.selectedTplIds = State.selectedTplIds.filter(x=>x!==id);
    debouncedFilterTemplates();
    renderTags('tmplSelected', State.selectedTplIds, State.templates, 'templateid', 'removeTpl');
};
window.removeGrp = (id) => {
    State.selectedGrpIds = State.selectedGrpIds.filter(x=>x!==id);
    debouncedFilterGroups();
    renderTags('groupSelected', State.selectedGrpIds, State.groups, 'groupid', 'removeGrp');
};
window.clearTemplates = () => {
    State.selectedTplIds = [];
    debouncedFilterTemplates();
    renderTags('tmplSelected', State.selectedTplIds, State.templates, 'templateid', 'removeTpl');
};
window.clearGroups = () => {
    State.selectedGrpIds = [];
    debouncedFilterGroups();
    renderTags('groupSelected', State.selectedGrpIds, State.groups, 'groupid', 'removeGrp');
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
    div.innerHTML = `<span class="tag-pill">${name} <button onclick="clearProxy()">&times;</button></span>`;
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
            jmx_port: parseInt(getVal('jmx_port')||10052),
            ssh_user: getVal('ssh_user'),
            ssh_password: getVal('ssh_password'),
            ssh_port: parseInt(getVal('ssh_port')||22),
            visible_name: getVal('visible_name') || null,
            template_ids: State.selectedTplIds,
            group_ids: State.selectedGrpIds,
            proxy_id: State.selectedProxyId,
            web_monitor_url: getVal('web_url') || null,

            // 控制参数
            precheck: document.getElementById('precheck') ? document.getElementById('precheck').checked : false, // Force disabled
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

// 6. ???????
function renderBatchHistorySelect() {
    const sel = document.getElementById('batchHistory');
    if (!sel) return;
    sel.innerHTML = '<option value="">??????</option>' + State.batchList.map(b => {
        const ts = b.ts ? new Date(b.ts * 1000).toLocaleString() : '';
        return `<option value="${b.batch_id}">${ts} (${b.count || 0}?)</option>`;
    }).join('');
    if (State.currentBatchId) sel.value = State.currentBatchId;
}

function renderBatchTable() {
    const tbody = document.querySelector('#batchTable tbody');
    if (!tbody) return;
    if (!State.batchRows.length) {
        tbody.innerHTML = '<tr><td colspan="13" style="text-align:center; color:#94a3b8;">????</td></tr>';
        return;
    }
    tbody.innerHTML = State.batchRows.map(row => {
        const id = String(row.item_id);
        const checked = State.batchSelection.has(id) ? 'checked' : '';
        const res = State.batchResults[id] || {};
        const status = res.status || '';
        const statusColor = status === 'ok' ? '#10b981' : (status === 'failed' ? '#ef4444' : '#64748b');
        const taskBtn = res.task_id ? `<button class="secondary" onclick="showTaskLog('${res.task_id}')">??</button>` : '';
        return `<tr>
            <td><input type="checkbox" ${checked} onchange="toggleBatchSelect('${id}')" /></td>
            <td>${escapeHtml(row.hostname || '')}</td>
            <td>${escapeHtml(row.ip || '')}</td>
            <td>${escapeHtml(row.env || '')}</td>
            <td>${escapeHtml(row.ssh_user || '')}</td>
            <td>${escapeHtml(row.ssh_port || '')}</td>
            <td>${escapeHtml(row.port || '')}</td>
            <td>${escapeHtml(row.jmx_port || '')}</td>
            <td>${escapeHtml(row.proxy_id || '')}</td>
            <td style="color:${statusColor};">${status || ''}${res.error ? (' - ' + escapeHtml(res.error)) : ''}</td>
            <td>${taskBtn}</td>
            <td>${escapeHtml((row.template_ids || []).join(',') || row.template_id || '')}</td>
            <td>${escapeHtml((row.group_ids || []).join(',') || row.group_id || '')}</td>
        </tr>`;
    }).join('');
}

window.toggleBatchSelect = (id) => {
    if (State.batchSelection.has(id)) State.batchSelection.delete(id);
    else State.batchSelection.add(id);
    renderBatchTable();
};

async function uploadBatch(btn) {
    const f = document.getElementById('batchFile').files[0];
    if(!f) return showToast('Please select file', 'error');

    await withLoading(btn, async () => {
        const fd = new FormData(); fd.append('file', f);
        const res = await api('/api/zabbix/batch/upload', { method:'POST', body:fd });
        const ok = handleResult(res, 'Upload success');
        if (ok && res.data) {
            State.currentBatchId = res.data.batch_id;
            State.batchRows = res.data.hosts || [];
            State.batchSelection = new Set(State.batchRows.map(h => String(h.item_id)));
            State.batchResults = {};
            document.getElementById('batchInfo').textContent = `Batch ${State.currentBatchId} (${State.batchRows.length} hosts)`;
            renderBatchTable();
            await refreshBatchList();
        }
    });
}

async function refreshBatchList() {
    const res = await api('/api/zabbix/batch/list');
    if (res.ok) {
        State.batchList = res.data || [];
        renderBatchHistorySelect();
    }
}

async function loadBatchById(id) {
    if (!id) return;
    const res = await api(`/api/zabbix/batch/${id}`);
    if (res.ok && res.data) {
        State.currentBatchId = res.data.batch_id;
        State.batchRows = res.data.hosts || [];
        State.batchSelection = new Set(State.batchRows.map(h => String(h.item_id)));
        State.batchResults = {};
        document.getElementById('batchInfo').textContent = `Batch ${State.currentBatchId} (${State.batchRows.length} hosts)`;
        renderBatchTable();
    } else {
        handleResult(res);
    }
}

async function runBatch(action = 'install', btn) {
    if (!State.currentBatchId || !State.batchRows.length) return showToast('?????????', 'error');
    const ids = Array.from(State.batchSelection);
    if (!ids.length) return showToast('??????', 'error');

    const mode = document.querySelector('input[name="install_mode"]:checked')?.value || 'full';
    let registerServer = true;
    if (mode === 'agent_only') registerServer = false;

    const payload = {
        batch_id: State.currentBatchId,
        host_ids: ids,
        action,
        template_ids: State.selectedTplIds,
        group_ids: State.selectedGrpIds,
        proxy_id: State.selectedProxyId,
        web_monitor_url: getVal('web_url') || null,
        jmx_port: parseInt(getVal('jmx_port')||10052),
        register_server: registerServer,
        precheck: document.getElementById('precheck') ? document.getElementById('precheck').checked : false,
    };

    await withLoading(btn, async () => {
        const res = await api('/api/zabbix/batch/run', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        if (handleResult(res, '??????')) {
            const results = res.data?.results || [];
            results.forEach(r => { State.batchResults[String(r.item_id)] = r; });
            renderBatchTable();
        }
    });
}
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
window.showTaskLog = (tid) => openLogModalWithTask(tid);
window.closeModal = (id) => { document.getElementById(id).style.display='none'; };

window.toggleDropdown = (id) => {
    const m = document.getElementById(id);
    const show = m.classList.contains('show');
    document.querySelectorAll('.dropdown-menu').forEach(x=>x.classList.remove('show'));
    if(!show) m.classList.add('show');
};
document.addEventListener('click', e => { if(!e.target.closest('.dropdown')) document.querySelectorAll('.dropdown-menu').forEach(x=>x.classList.remove('show')); });
