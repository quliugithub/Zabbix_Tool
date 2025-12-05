
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
    logFilter: null,
    currentTask: null,
    logDetail: '',
};
State.batchRows = State.batchRows || [];
State.batchSelection = new Set();
State.batchList = State.batchList || [];
State.batchResults = {};
State.currentBatchId = null;
State.currentBatchName = '';
State.selector = { type: null, rowId: null, rowIds: [], filter: '', temp: new Set(), context: 'batch' };
State.historyHidden = State.historyHidden || false;
State.historyFloatPos = State.historyFloatPos || null;
State.batchResizeBound = false;
State.lastInstallFilter = null;
State.batchQueueId = null;
State.batchQueueTimer = null;
State.batchDirty = false;
State._unsavedResolve = null;

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
const parseWebUrls = (val) => {
    if (!val) return [];
    return val.split(/[\n;,]+/).map(x => x.trim()).filter(Boolean);
};

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

async function loadLogList(params = null) {
    const p = params !== null ? params : (State.logFilter || {});
    State.logFilter = p;
    const qs = new URLSearchParams();
    if (p.limit) qs.set('limit', p.limit);
    if (p.hostname) qs.set('hostname', p.hostname);
    if (p.ip) qs.set('ip', p.ip);
    if (p.host_id) qs.set('host_id', p.host_id);
    if (p.zabbix_url) qs.set('zabbix_url', p.zabbix_url);
    const url = qs.toString() ? `/api/zabbix/logs?${qs.toString()}` : '/api/zabbix/logs';
    const res = await api(url);
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

async function refreshLogList() {
    const logContentEl = document.getElementById('logContent');
    if (logContentEl) logContentEl.textContent = '加载任务列表...';
    await loadLogList();
    const availableIds = State.logList.map(x => x.task_id);
    const tid = (State.currentTask && availableIds.includes(State.currentTask)) ? State.currentTask : (State.logList[0]?.task_id || null);
    if (tid) {
        await viewLog(tid);
    } else if (logContentEl) {
        logContentEl.textContent = '暂无历史日志';
    }
}

// === 业务逻辑 ===

// 1. 初始化
async function loadFragments() {
    const container = document.getElementById('tabContainer');
    if (!container) return;
    const files = ['dashboard','install','batch','tmpl','group','bind','config'];
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
    bindBatchNameInput();
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
    // 如果刷新后仍有未完成队列，继续轮询
    await recoverActiveQueue();
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
        setVal('cfg_server_host', c.zabbix_server_host);
        setVal('local_agent_path', c.local_agent_path);
        setVal('agent_install_dir', c.agent_install_dir);
        setVal('project_name', c.project_name);
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
            agent_install_dir: getVal('agent_install_dir') || '/opt/zabbix-agent/',
            project_name: getVal('project_name') || '',
            zabbix_version: getVal('cfg_version'),
            zabbix_server_host: getVal('cfg_server_host'),
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
    const select = document.getElementById('proxySelectInstall');
    if (!select) return;
    const kw = (getVal('proxyFilter') || '').toLowerCase();
    const filtered = State.proxies.filter(p =>
        (p.name && p.name.toLowerCase().includes(kw)) || (p.host && p.host.toLowerCase().includes(kw))
    );
    select.innerHTML = '<option value="">未选择</option>' + filtered.map(p => {
        const id = p.proxyid;
        const label = escapeHtml(p.name || p.host || id);
        const selected = String(State.selectedProxyId) === String(id) ? 'selected' : '';
        return `<option value="${id}" ${selected}>${label}</option>`;
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
    renderProxyDropdown();
};

const renderTags = (containerId, ids, source, idKey, removeFnName) => {
    const div = document.getElementById(containerId);
    if (!div) return;
    if (!ids.length) {
        div.innerHTML = '<span class="chip-empty">未选择</span>';
        const placeholder = div.parentElement?.querySelector('.chip-placeholder');
        if (placeholder) placeholder.style.display = 'block';
        return;
    }
    const placeholder = div.parentElement?.querySelector('.chip-placeholder');
    if (placeholder) placeholder.style.display = 'none';

    div.innerHTML = ids.map(id => {
        const item = source.find(x => String(x[idKey]) === String(id));
        const name = item ? escapeHtml(item.name || item.host) : id;
        return `<span class="chip-pill">${name} <button class="chip-remove" onclick="event.stopPropagation(); ${removeFnName}('${id}')">×</button></span>`;
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
        div.innerHTML = '<span class="chip-empty">未选择</span>';
        const placeholder = div.parentElement?.querySelector('.chip-placeholder');
        if (placeholder) placeholder.style.display = 'block';
        return;
    }
    const placeholder = div.parentElement?.querySelector('.chip-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    const p = State.proxies.find(x => String(x.proxyid) === String(State.selectedProxyId));
    const name = p ? escapeHtml(p.name || p.host || State.selectedProxyId) : State.selectedProxyId;
    div.innerHTML = `<span class="proxy-chip"><span class="proxy-ico">🌐</span><span>${name}</span><span class="proxy-status ok">已连接</span><button class="chip-remove" onclick="event.stopPropagation(); clearProxy()">×</button></span>`;
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
            port: parseInt(getVal('port')||10050),
            ssh_user: getVal('ssh_user'),
            ssh_password: getVal('ssh_password'),
            ssh_port: parseInt(getVal('ssh_port')||22),
            visible_name: getVal('visible_name') || null,
            template_ids: State.selectedTplIds,
            group_ids: State.selectedGrpIds,
            proxy_id: State.selectedProxyId,
            web_monitor_urls: parseWebUrls(getVal('web_url')),
            web_monitor_url: parseWebUrls(getVal('web_url'))[0] || null,

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
                State.lastInstallFilter = {
                    host_id: res.data.host_id || null,
                    zabbix_url: res.data.zabbix_url || (State.config?.zabbix_api_base || null),
                    ip: payload.ip || null,
                };
                await showInstallLog(res.data.task_id);
            }
        }
    });
}

async function uninstall(btn) {
    const ip = getVal('ip');
    if (!ip) return showToast('请先填写 IP 地址', 'error');
    if (!confirm("⚠️ 警告：确定要卸载该主机的 Agent 吗？此操作不可恢复！")) return;
    await withLoading(btn, async () => {
        const payload = {
            ip,
            hostname: getVal('host') || null,
            proxy_id: State.selectedProxyId,
            ssh_user: getVal('ssh_user'),
            ssh_password: getVal('ssh_password'),
            ssh_port: parseInt(getVal('ssh_port')||22),
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
        const count = item.count || (item.hosts?.length ?? 0) || 0;
        const title = item.name?.trim() || '未命名批次';
        const meta = `共 ${count} 台`;
        const safeTitle = escapeHtml(title);
        const safeMeta = escapeHtml(meta);
        return `<div class="history-item ${active}" data-batch-id="${item.batch_id}" onclick="loadBatchById('${item.batch_id}')">
            <div class="history-item-title" title="双击重命名" onclick="stopHistoryClick(event)" ondblclick="startHistoryRename(event, '${item.batch_id}')">${safeTitle}</div>
            <div class="history-item-meta">${safeMeta}</div>
        </div>`;
    }).join('');
}

window.stopHistoryClick = (e) => e.stopPropagation();

window.startHistoryRename = (event, batchId) => {
    event.stopPropagation();
    const titleEl = event.currentTarget || event.target;
    const itemEl = titleEl?.closest('.history-item');
    if (!itemEl || titleEl.dataset.editing === '1') return;

    const currentName = titleEl.textContent.trim();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName;
    input.className = 'history-rename-input';
    titleEl.dataset.editing = '1';
    titleEl.innerHTML = '';
    titleEl.appendChild(input);
    input.focus();
    input.select();

    let finished = false;
    const restore = (nameToShow) => {
        titleEl.removeAttribute('data-editing');
        titleEl.textContent = nameToShow;
    };
    const submit = async () => {
        if (finished) return;
        finished = true;
        const newName = (input.value || '').trim();
        if (!newName || newName === currentName) {
            restore(currentName);
            return;
        }
        const ok = await renameBatchById(batchId, newName);
        restore(ok ? newName : currentName);
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submit();
        } else if (e.key === 'Escape') {
            finished = true;
            restore(currentName);
        }
    });
    input.addEventListener('blur', submit);
    input.addEventListener('click', (e) => e.stopPropagation());
};

async function renameBatchById(batchId, newName) {
    const name = (newName || '').trim();
    if (!name) {
        showToast('批次名称不能为空', 'warning');
        return false;
    }

    let hosts = [];
    if (State.currentBatchId && String(State.currentBatchId) === String(batchId)) {
        hosts = State.batchRows || [];
    } else {
        const res = await api(`/api/zabbix/batch/${batchId}`);
        if (!res.ok) {
            handleResult(res);
            return false;
        }
        hosts = res.data?.hosts || [];
    }

    if (!hosts.length) {
        showToast('该批次没有可保存的主机数据', 'warning');
        return false;
    }

    const payload = { name, batch_id: batchId, hosts };
    const resSave = await api('/api/zabbix/batch/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const ok = handleResult(resSave, '批次名称已更新');
    if (ok) {
        if (State.currentBatchId && String(State.currentBatchId) === String(batchId)) {
            State.currentBatchName = name;
            setVal('batchNameInput', name);
            updateBatchInfoLabel();
            State.batchDirty = false;
        }
        await refreshBatchList();
    }
    return ok;
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

    updateBatchInfoLabel();
    const nameInput = document.getElementById('batchNameInput');
    if (nameInput && nameInput !== document.activeElement) {
        nameInput.value = State.currentBatchName || '';
    }

    if (!tbody) return;
    const headerCheckbox = document.getElementById('batchSelectAll');
    if (headerCheckbox) {
        const total = State.batchRows.length;
        const selected = State.batchSelection.size;
        headerCheckbox.checked = total > 0 && selected === total;
        headerCheckbox.indeterminate = selected > 0 && selected < total;
    }
    if (!State.batchRows.length) {
        tbody.innerHTML = '<tr><td colspan="15" style="text-align:center; color:#94a3b8; padding: 20px;">暂无数据，请导入或添加</td></tr>';
        updateBatchActions();
        return;
    }
    tbody.innerHTML = State.batchRows.map(row => {
        const id = String(row.item_id);
        const checked = State.batchSelection.has(id) ? 'checked' : '';
        const res = State.batchResults[id] || {};
        const statusRaw = (res.status || '').toLowerCase();
        const statusClass = (['ok','installed','uninstalled'].includes(statusRaw)) ? 'ok'
                            : (statusRaw === 'failed' ? 'failed'
                            : (['installing','running','in-progress'].includes(statusRaw) ? 'installing' : 'pending'));
        const statusColor = statusClass === 'ok' ? '#10b981'
                            : (statusClass === 'failed' ? '#ef4444'
                            : (statusClass === 'installing' ? '#0ea5e9' : '#94a3b8'));
        const statusIcon = statusClass === 'ok' ? '✔'
                          : (statusClass === 'failed' ? '✖'
                          : (statusClass === 'installing' ? '⏳' : '•'));
        
        const proxyObj = State.proxies.find(p => String(p.proxyid) === String(row.proxy_id));
        const proxyLabel = proxyObj ? escapeHtml(proxyObj.name || proxyObj.host || proxyObj.proxyid) : (row.proxy_id ? escapeHtml(row.proxy_id) : '');
        const proxyHtml = proxyLabel
            ? `<span class="proxy-chip"><span class="proxy-ico">🌐</span><span>${proxyLabel}</span><span class="proxy-status ok">已连接</span></span>`
            : '<span style="color:#94a3b8;">未选</span>';

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
                <td><input value="${escapeHtml(row.visible_name || '')}" oninput="editBatchField('${id}','visible_name',this.value)" /></td>
                <td><input value="${escapeHtml(row.ssh_user || '')}" oninput="editBatchField('${id}','ssh_user',this.value)" /></td>
                <td><input type="password" value="${escapeHtml(row.ssh_password || '')}" oninput="editBatchField('${id}','ssh_password',this.value)" /></td>
                <td><input value="${escapeHtml(row.ssh_port || '')}" oninput="editBatchField('${id}','ssh_port',this.value)" style="width:70px;" /></td>
                <td><input value="${escapeHtml(row.port || '')}" oninput="editBatchField('${id}','port',this.value)" style="width:70px;" /></td>
                <td><input value="${escapeHtml(row.jmx_port || '')}" oninput="editBatchField('${id}','jmx_port',this.value)" style="width:70px;" /></td>
                <td><input value="${escapeHtml(row.web_monitor_url || '')}" placeholder="多值用;分隔" oninput="editBatchField('${id}','web_monitor_url',this.value)" /></td>
                <td>
                    <div class="selector-cell">
                        <div class="tag-chips">${proxyHtml}</div>
                        <button class="secondary" onclick="openSelector('proxy','${id}','batch-proxy')">选择</button>
                    </div>
                </td>
                <td>
                    <div class="selector-cell">
                        <div class="tag-chips">${tmplTags}</div>
                        <button class="secondary" onclick="openSelector('tmpl','${id}','batch')">选择</button>
                    </div>
                </td>
                <td>
                    <div class="selector-cell">
                        <div class="tag-chips">${grpTags}</div>
                        <button class="secondary" onclick="openSelector('grp','${id}','batch')">选择</button>
                    </div>
                </td>
                <td style="color:${statusColor};">
                    <span class="status-ico ${statusClass}">${statusIcon}</span>
                    ${status ? escapeHtml(status) : ''}
                </td>
                <td><button class="secondary" onclick="viewRowLog('${id}')">日志</button></td>
            </tr>
        `;
    }).join('');
    updateBatchActions();
    setupBatchColumnResize();
}

window.updateBatchActions = function updateBatchActions() {
    const hasSelection = State.batchSelection.size > 0;
    const singleSelection = State.batchSelection.size === 1;
    const delBtn = document.getElementById('deleteRowsBtn');
    if (delBtn) delBtn.disabled = !hasSelection;
    const viewLogBtn = document.getElementById('viewRowLogBtn');
    if (viewLogBtn) viewLogBtn.disabled = !singleSelection;
    const applyTplBtn = document.getElementById('applyTplBtn');
    const applyGrpBtn = document.getElementById('applyGrpBtn');
    const applyProxyBtn = document.getElementById('applyProxyBtn');
    [applyTplBtn, applyGrpBtn, applyProxyBtn].forEach(btn => {
        if (btn) btn.disabled = !hasSelection;
    });
};

function updateBatchInfoLabel() {
    const infoEl = document.getElementById('batchInfo');
    if (!infoEl) return;
    const count = State.batchRows.length;
    if (State.currentBatchId) {
        const name = State.currentBatchName || `批次 ${State.currentBatchId}`;
        infoEl.textContent = `${name} · ${count} 条`;
    } else {
        const name = State.currentBatchName ? `草稿 ${State.currentBatchName}` : '未保存批次';
        infoEl.textContent = count ? `${name} · ${count} 条` : '当前未选择批次';
    }
}

function setBatchTableLoading(show) {
    const container = document.querySelector('.editable-table-container');
    const overlay = document.getElementById('batchTableLoading');
    if (container) container.classList.toggle('loading', !!show);
    if (overlay) overlay.style.display = show ? 'flex' : 'none';
}

function bindBatchNameInput() {
    const input = document.getElementById('batchNameInput');
    if (!input) return;
    input.addEventListener('input', (e) => {
        State.currentBatchName = e.target.value || '';
        updateBatchInfoLabel();
    });
    // 提交保存
    input.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') {
            saveCurrentBatch();
        }
    });
}

function getSelectedBatchIds() {
    return Array.from(State.batchSelection);
}

window.toggleBatchSelect = (id) => {
    if (State.batchSelection.has(id)) {
        State.batchSelection.delete(id);
    } else {
        State.batchSelection.add(id);
    }
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

window.onProxySelectChange = (rowId, selectEl) => {
    const row = State.batchRows.find(r => String(r.item_id) === String(rowId));
    if (!row) return;
    row.proxy_id = selectEl.value || '';
    State.batchDirty = true;
};

function editBatchField(id, field, value) {
    const row = State.batchRows.find(r => String(r.item_id) === String(id));
    if (row) row[field] = value;
    State.batchDirty = true;
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

        const startResize = (pageX) => {
            const startX = pageX;
            const startWidth = th.offsetWidth;
            const move = (ev) => {
                const delta = ev.pageX - startX;
                const minWidth = idx === 0 ? 20 : 20;
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
        };

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startResize(e.pageX);
        });

        // 允许点击表头右侧区域开始拖拽
        th.addEventListener('mousedown', (e) => {
            if (th.offsetWidth - e.offsetX <= 12) {
                e.preventDefault();
                startResize(e.pageX);
            }
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
    State.batchDirty = true;
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
    State.currentBatchName = '';
    setVal('batchNameInput', '');
    State.batchDirty = true;
    renderBatchTable();
    showToast('已清空当前表格数据');
};

window.deleteSelectedRows = () => deleteSelectedBatchRows();

function renderSelectorOptions() {
    const listEl = document.getElementById('selectorList');
    if (!listEl || !State.selector.type) return;
    const keyword = (document.getElementById('selectorSearch')?.value || '').toLowerCase();
    const source = State.selector.type === 'grp' ? State.groups : (State.selector.type === 'proxy' ? State.proxies : State.templates);
    const idKey = State.selector.type === 'grp' ? 'groupid' : (State.selector.type === 'proxy' ? 'proxyid' : 'templateid');
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
        const inputType = State.selector.type === 'proxy' ? 'radio' : 'checkbox';
        const onChange = State.selector.type === 'proxy' ? 'toggleSelectorItem(this, true)' : 'toggleSelectorItem(this)';
        return `<label class="selector-item"><input type="${inputType}" name="selector-${State.selector.type}" value="${id}" ${checked} onchange="${onChange}"> <span>${name}</span></label>`;
    }).join('');
}

window.openSelector = (type, rowId, context = 'batch') => {
    State.selector.type = type;
    State.selector.rowId = rowId;
    State.selector.rowIds = [];
    State.selector.context = context;
    State.selector.temp = new Set();
    if (context === 'batch') {
        const row = State.batchRows.find(r => String(r.item_id) === String(rowId));
        if (row) {
            const defaults = type === 'grp' ? (row.group_ids || []) : (row.template_ids || []);
            defaults.forEach(id => State.selector.temp.add(String(id)));
        }
    } else if (context === 'batch-multi') {
        State.selector.rowIds = Array.from(State.batchSelection);
        const firstRow = State.batchRows.find(r => State.selector.rowIds.includes(String(r.item_id)));
        if (firstRow) {
            const defaults = type === 'grp' ? (firstRow.group_ids || []) : (firstRow.template_ids || []);
            defaults.forEach(id => State.selector.temp.add(String(id)));
        }
    } else if (context === 'batch-proxy') {
        const row = State.batchRows.find(r => String(r.item_id) === String(rowId));
        if (row && row.proxy_id) State.selector.temp.add(String(row.proxy_id));
    } else if (context === 'batch-proxy-multi') {
        State.selector.rowIds = Array.from(State.batchSelection);
        const firstRow = State.batchRows.find(r => State.selector.rowIds.includes(String(r.item_id)));
        if (firstRow && firstRow.proxy_id) State.selector.temp.add(String(firstRow.proxy_id));
    } else if (context === 'install') {
        const defaults = type === 'grp' ? State.selectedGrpIds : State.selectedTplIds;
        defaults.forEach(id => State.selector.temp.add(String(id)));
    } else if (context === 'install-proxy') {
        if (State.selectedProxyId) State.selector.temp.add(String(State.selectedProxyId));
    }
    const titleEl = document.getElementById('selectorTitle');
    if (titleEl) titleEl.textContent = type === 'grp' ? '选择群组' : (type === 'proxy' ? '选择 Proxy' : '选择模板');
    const searchEl = document.getElementById('selectorSearch');
    if (searchEl) searchEl.value = '';
    renderSelectorOptions();
    const modal = document.getElementById('selectorModal');
    if (modal) modal.style.display = 'flex';
};

window.toggleSelectorItem = (el, single = false) => {
    const id = el.value;
    if (single) {
        State.selector.temp = new Set();
        if (el.checked) State.selector.temp.add(id);
    } else {
        if (el.checked) State.selector.temp.add(id);
        else State.selector.temp.delete(id);
    }
};

window.filterSelectorList = () => renderSelectorOptions();

window.clearSelectorChoices = () => {
    State.selector.temp = new Set();
    renderSelectorOptions();
};

window.viewRowLog = async (rowId) => {
    const row = State.batchRows.find(r => String(r.item_id) === String(rowId));
    if (!row) return;
    State.batchSelection = new Set([String(rowId)]);
    updateBatchActions();
    const res = State.batchResults[String(rowId)];
    const tid = res && res.task_id ? res.task_id : (State.taskIds.batch?.[0] || null);
    const hostId = res && res.host_id ? res.host_id : null;
    const zabbixUrl = (res && res.zabbix_url) ? res.zabbix_url : (State.config?.zabbix_api_base || null);
    document.getElementById('logModal').style.display='flex';
    document.getElementById('logContent').textContent = '加载任务列表...';
    // 优先按 host_id + zabbix_url 过滤，其次按 IP 过滤，避免主机名重复
    const filter = { host_id: hostId, ip: row.ip || null, zabbix_url: zabbixUrl, task_id: tid };
    State.logFilter = filter;
    await loadLogList(filter);
    if (tid) {
        await viewLog(tid);
    } else if (State.logList.length) {
        await viewLog(State.logList[0].task_id);
    } else {
        document.getElementById('logContent').textContent = '暂无任务日志';
    }
};

window.viewSelectedRowLog = async () => {
    const ids = Array.from(State.batchSelection);
    if (ids.length !== 1) {
        showToast('请先选择单条数据查看日志', 'warning');
        return;
    }
    await viewRowLog(ids[0]);
};

window.applyTemplateToSelection = () => {
    if (!State.batchSelection.size) return showToast('请先勾选至少一条数据', 'warning');
    openSelector('tmpl', null, 'batch-multi');
};

window.applyGroupToSelection = () => {
    if (!State.batchSelection.size) return showToast('请先勾选至少一条数据', 'warning');
    openSelector('grp', null, 'batch-multi');
};

window.applyProxyToSelection = () => {
    const ids = Array.from(State.batchSelection);
    if (!ids.length) return showToast('请先勾选至少一条数据', 'warning');
    if (!State.proxies.length) return showToast('暂无 Proxy 列表', 'warning');
    openSelector('proxy', null, 'batch-proxy-multi');
};

window.confirmSelector = () => {
    if (State.selector.context === 'install') {
        if (State.selector.type === 'grp') {
            State.selectedGrpIds = Array.from(State.selector.temp);
            renderTags('groupSelected', State.selectedGrpIds, State.groups, 'groupid', 'removeGrp');
        } else {
            State.selectedTplIds = Array.from(State.selector.temp);
            renderTags('tmplSelected', State.selectedTplIds, State.templates, 'templateid', 'removeTpl');
        }
        closeSelector();
    } else if (State.selector.context === 'install-proxy') {
        const vals = Array.from(State.selector.temp);
        State.selectedProxyId = vals[0] || null;
        renderProxySelected();
        closeSelector();
    } else if (State.selector.context === 'batch-multi') {
        const ids = State.selector.rowIds || [];
        ids.forEach(rid => {
            const row = State.batchRows.find(r => String(r.item_id) === String(rid));
            if (!row) return;
            if (State.selector.type === 'grp') {
                row.group_ids = Array.from(State.selector.temp);
            } else {
                row.template_ids = Array.from(State.selector.temp);
            }
        });
        closeSelector();
        State.batchDirty = true;
        renderBatchTable();
    } else if (State.selector.context === 'batch-proxy') {
        const row = State.batchRows.find(r => String(r.item_id) === String(State.selector.rowId));
        if (row) {
            row.proxy_id = Array.from(State.selector.temp)[0] || '';
        }
        closeSelector();
        State.batchDirty = true;
        renderBatchTable();
    } else if (State.selector.context === 'batch-proxy-multi') {
        const val = Array.from(State.selector.temp)[0] || '';
        const ids = State.selector.rowIds || [];
        ids.forEach(rid => {
            const row = State.batchRows.find(r => String(r.item_id) === String(rid));
            if (row) row.proxy_id = val;
        });
        closeSelector();
        State.batchDirty = true;
        renderBatchTable();
    } else {
        const row = State.batchRows.find(r => String(r.item_id) === String(State.selector.rowId));
        if (row) {
            if (State.selector.type === 'grp') {
                row.group_ids = Array.from(State.selector.temp);
            } else {
                row.template_ids = Array.from(State.selector.temp);
            }
        }
        closeSelector();
        State.batchDirty = true;
        renderBatchTable();
    }
};

window.closeSelector = () => {
    const modal = document.getElementById('selectorModal');
    if (modal) modal.style.display = 'none';
    State.selector.type = null;
    State.selector.rowId = null;
    State.selector.temp = new Set();
    State.selector.context = 'batch';
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
        State.currentBatchName = res.data.name || '';
        State.batchRows = res.data.hosts || [];
        State.batchSelection = new Set(State.batchRows.map(h => String(h.item_id)));
        State.batchResults = {};
        if (Array.isArray(res.data.results)) {
            res.data.results.forEach(r => { State.batchResults[String(r.item_id)] = r; });
        }
        setVal('batchNameInput', State.currentBatchName || '');
        renderBatchTable();
        renderBatchHistoryList(); // 更新选中状态
        State.batchDirty = false;
    } else {
        handleResult(res);
    }
}

// 批量执行
async function runBatch(action = 'install', btn) {
    // 如果没有批次ID，先创建一个临时批次 (对于手动添加的数据)
    // 这里简化逻辑：必须先有数据
    if (!State.batchRows.length) return showToast('请先添加数据', 'error');
    if (State.batchQueueId) return showToast('已有批量任务执行中，请稍后再提交', 'warning');
    
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

    const mode = document.querySelector('input[name="batch_install_mode"]:checked')?.value
        || document.querySelector('input[name="install_mode"]:checked')?.value
        || 'full';
    let registerServer = true;
    let registerOnly = false;
    if (mode === 'agent_only') registerServer = false;
    if (mode === 'register_only') { registerServer = true; registerOnly = true; }

    // 构造 payload
    const payload = {
        batch_id: State.currentBatchId, // 可能为空
        host_ids: ids,
        action,
        template_ids: State.selectedTplIds,
        group_ids: State.selectedGrpIds,
        proxy_id: State.selectedProxyId,
        web_monitor_urls: parseWebUrls(getVal('web_url')),
        web_monitor_url: parseWebUrls(getVal('web_url'))[0] || null,
        jmx_port: parseInt(getVal('jmx_port')||10052),
        register_server: registerServer,
        register_only: registerOnly,
        precheck: false,
        // 如果后端支持直接传 hosts 数据，可以在这里扩展
        // hosts: State.batchRows.filter(r => ids.includes(String(r.item_id)))
    };

    // 标记选中行为“安装中”状态，便于 UI 实时显示（后端亦会写入 installing）
    const ready = await ensureBatchReady(btn);
    if (!ready) return;
    ids.forEach(id => {
        State.batchResults[String(id)] = { ...(State.batchResults[String(id)] || {}), status: 'installing', task_id: null, error: null };
    });
    renderBatchTable();

    await withLoading(btn, async () => {
        const res = await api('/api/zabbix/batch/run', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        if (handleResult(res, '批量任务已提交')) {
            const queueId = res.data?.queue_id;
            if (queueId) {
                startBatchQueuePolling(queueId);
            } else {
                showToast('队列ID缺失，无法跟踪任务', 'warning');
            }
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
            State.currentBatchName = res.data.name || f.name || '';
            State.batchRows = res.data.hosts || [];
            State.batchSelection = new Set(State.batchRows.map(h => String(h.item_id)));
            State.batchResults = {};
            renderBatchTable();
            await refreshBatchList();
            State.batchDirty = false;
        }
    });
}

async function ensureBatchReady(btn) {
    if (!State.currentBatchId || State.batchDirty) {
        const ok = await showUnsavedModal(btn);
        return !!ok;
    }
    return true;
}

async function saveCurrentBatch(btn) {
    const name = (getVal('batchNameInput') || '').trim();
    if (!name) return showToast('请填写批次名称', 'warning');
    if (!State.batchRows.length) return showToast('请先添加数据后再保存', 'warning');
    let success = false;

    const dup = State.batchList.find(
        b => (b.name || '').trim().toLowerCase() === name.toLowerCase() && String(b.batch_id) !== String(State.currentBatchId || '')
    );
    if (dup) return showToast('批次名已存在，请更换名称', 'error');

    const payload = {
        name,
        batch_id: State.currentBatchId,
        hosts: State.batchRows
    };
    await withLoading(btn, async () => {
        const res = await api('/api/zabbix/batch/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        if (handleResult(res, '批次已保存')) {
            State.currentBatchId = res.data?.batch_id || State.currentBatchId;
            State.currentBatchName = name;
            State.batchSelection = new Set(State.batchRows.map(h => String(h.item_id)));
            await refreshBatchList();
            renderBatchTable();
            closeModal('saveBatchModal');
            State.batchDirty = false;
            success = true;
        }
    });
    return success;
}

window.createNewBatch = () => {
    const hasData = State.batchRows.length || State.batchDirty || State.currentBatchId;
    if (hasData) {
        const ok = confirm('当前批次内容将被清空，确认创建新的空白批次吗？');
        if (!ok) return;
    }
    State.currentBatchId = null;
    State.currentBatchName = '';
    State.batchRows = [];
    State.batchSelection.clear();
    State.batchResults = {};
    State.batchDirty = false;
    setVal('batchNameInput', '');
    const display = document.getElementById('fileNameDisplay');
    const bar = document.getElementById('fileStatusBar');
    if (display) display.textContent = '';
    if (bar) bar.classList.remove('show');
    renderBatchTable();
    updateBatchInfoLabel();
    showToast('已创建空白批次，请导入或手动添加数据');
    setTimeout(() => {
        const input = document.getElementById('batchNameInput');
        if (input) input.focus();
    }, 0);
};

async function refreshCurrentBatch(btn) {
    if (!State.currentBatchId) return showToast('请先选择批次', 'warning');
    if (State.batchDirty) {
        const ok = confirm('检测到未保存的修改，刷新会丢失这些修改，是否继续？');
        if (!ok) return;
    }
    setBatchTableLoading(true);
    try {
        await withLoading(btn, async () => {
            await loadBatchById(State.currentBatchId);
        });
    } finally {
        setBatchTableLoading(false);
    }
}

async function renameBatch(btn) {
    if (!State.currentBatchId) return showToast('请先选择批次', 'warning');
    if (State.batchDirty) {
        const ok = await ensureBatchReady(null);
        if (!ok) return;
    }
    const modal = document.getElementById('saveBatchModal');
    const titleEl = document.getElementById('saveBatchTitle');
    if (titleEl) titleEl.textContent = '重命名批次';
    setVal('batchNameInput', State.currentBatchName || '');
    if (modal) modal.style.display = 'flex';
    setTimeout(() => {
        const input = document.getElementById('batchNameInput');
        if (input) { input.focus(); input.select(); }
    }, 0);
}

async function deleteBatch(btn) {
    if (!State.currentBatchId) return showToast('请先选择批次', 'warning');
    if (State.batchQueueId) return showToast('当前有执行中的批量任务，请先终止后再删除', 'warning');
    if (!confirm('确定删除当前批次及其记录吗？')) return;
    await withLoading(btn, async () => {
        const res = await api(`/api/zabbix/batch/${State.currentBatchId}`, { method: 'DELETE' });
        if (!handleResult(res, '批次已删除')) return;
        State.currentBatchId = null;
        State.currentBatchName = '';
        State.batchRows = [];
        State.batchSelection.clear();
        State.batchResults = {};
        State.batchDirty = false;
        renderBatchTable();
        await refreshBatchList();
        setVal('batchNameInput', '');
        showToast('批次已删除', 'success');
    });
}

function showUnsavedModal(btn) {
    return new Promise(resolve => {
        State._unsavedResolve = { resolve, btn };
        const modal = document.getElementById('unsavedModal');
        if (modal) modal.style.display = 'flex';
    });
}

window.closeUnsavedModal = (ok = false) => {
    const modal = document.getElementById('unsavedModal');
    if (modal) modal.style.display = 'none';
    const res = State._unsavedResolve;
    State._unsavedResolve = null;
    if (res) res.resolve(ok);
};

window.confirmUnsavedAndSave = async () => {
    const ctx = State._unsavedResolve;
    const btn = ctx?.btn || null;
    const ok = await saveCurrentBatch(btn);
    if (ok) {
        closeUnsavedModal(true);
    } else {
        closeUnsavedModal(false);
    }
};

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
    State.batchDirty = true;
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
    const resp = await fetch('/api/zabbix/batch/template/download');
    if (!resp.ok) {
        showToast('下载模板失败', 'error');
        return;
    }
    const blob = await resp.blob();
    const filename = 'zabbix_batch_template.xlsx';
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

async function openLogModalWithTask(targetTaskId, filterParams = null) {
    State.logDetail = '';
    const logContentEl = document.getElementById('logContent');
    if (logContentEl) logContentEl.textContent = '';
    document.getElementById('logModal').style.display='flex';
    if (logContentEl) logContentEl.textContent = '加载任务列表...';
    const fp = filterParams || {};
    await loadLogList(fp);

    const availableIds = State.logList.map(x => x.task_id);
    const tid = (targetTaskId && availableIds.includes(targetTaskId)) ? targetTaskId : (State.logList[0]?.task_id || null);
    if (tid) {
        await viewLog(tid);
    } else {
        document.getElementById('logContent').textContent = '暂无历史日志';
    }
}

function startBatchQueuePolling(queueId) {
    // 避免重复启动
    if (State.batchQueueId === queueId) return;
    State.batchQueueId = queueId;
    localStorage.setItem('batchQueueId', queueId);
    updateCancelBtn();
    if (State.batchQueueTimer) clearTimeout(State.batchQueueTimer);
    const poll = async () => {
        await pollBatchQueue(queueId);
        if (State.batchQueueId === queueId) {
            State.batchQueueTimer = setTimeout(poll, 1000);
        }
    };
    poll();
}

async function pollBatchQueue(queueId) {
    const res = await api(`/api/zabbix/batch/queue/${queueId}`);
    if (!res.ok) {
        showToast(`队列状态获取失败: ${res.msg}`, 'error');
        State.batchQueueId = null;
        updateCancelBtn();
        localStorage.removeItem('batchQueueId');
        return;
    }
    const data = res.data || {};
    const results = data.results || [];
    // 仅在任务完成/失败时应用结果，避免旧结果覆盖前端中的“安装中”状态
    if (data.status === 'done' || data.status === 'failed' || data.status === 'cancelled') {
        results.forEach(r => { State.batchResults[String(r.item_id)] = r; });
        if (Array.isArray(results) && results.length) {
            State.taskIds.batch = results.map(r => r.task_id).filter(Boolean);
        }
    }
    renderBatchTable();
    if (data.status === 'done' || data.status === 'failed' || data.status === 'cancelled') {
        State.batchQueueId = null;
        if (State.batchQueueTimer) clearTimeout(State.batchQueueTimer);
        State.batchQueueTimer = null;
        if (data.status === 'failed' && data.error) showToast(`批量任务失败: ${data.error}`, 'error');
        if (data.status === 'cancelled') {
            showToast('批量任务已取消', 'warning');
            // 将安装中的行标记为 failed: cancelled
            Object.keys(State.batchResults).forEach(id => {
                const r = State.batchResults[id] || {};
                if (!r.status || r.status === 'installing') {
                    State.batchResults[id] = { ...r, status: 'failed', error: 'cancelled' };
                }
            });
            renderBatchTable();
        }
    }
    updateCancelBtn();
}

async function cancelBatchQueue() {
    if (!State.batchQueueId) return;
    if (!confirm('确认终止当前批量任务吗？')) return;
    const res = await api(`/api/zabbix/batch/queue/${State.batchQueueId}/cancel`, { method: 'POST' });
    if (res.ok) {
        showToast('终止指令已发送', 'success');
        // 立即标记状态为取消，等待轮询刷新结果
        Object.keys(State.batchResults).forEach(id => {
            const r = State.batchResults[id] || {};
            if (r.status === 'installing' || r.status === 'pending' || !r.status) {
                State.batchResults[id] = { ...r, status: 'failed', error: 'cancelled' };
            }
        });
        renderBatchTable();
    } else {
        showToast(`终止失败: ${res.msg}`, 'error');
    }
    updateCancelBtn();
}

function updateCancelBtn() {
    const btn = document.getElementById('cancelQueueBtn');
    if (!btn) return;
    btn.disabled = !State.batchQueueId;
}

async function recoverActiveQueue() {
    const res = await api('/api/zabbix/batch/queue/active');
    if (!res.ok) return;
    const list = res.data || [];
    if (list.length) {
        // 取最近一个 active queue 开始轮询
        startBatchQueuePolling(list[0].queue_id);
    }
}

window.showInstallLog = (tid) => {
    const currentIp = getVal('ip') || null;
    const filter = {
        ...(State.lastInstallFilter?.host_id ? { host_id: State.lastInstallFilter.host_id } : {}),
        ...(State.lastInstallFilter?.zabbix_url ? { zabbix_url: State.lastInstallFilter.zabbix_url } : {}),
        ...(currentIp ? { ip: currentIp } : {}),
    };
    return openLogModalWithTask(tid || State.taskIds.install, filter);
};
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
window.onSaveBatchClick = (btn) => {
    if (!State.batchRows.length) return showToast('请先添加数据后再保存', 'warning');
    if (State.currentBatchId) {
        if (!State.currentBatchName) return showToast('当前批次未命名，请先命名', 'warning');
        return saveCurrentBatch(btn);
    }
    openSaveBatchModal();
};

function openSaveBatchModal() {
    const modal = document.getElementById('saveBatchModal');
    if (!modal) return;
    setVal('batchNameInput', State.currentBatchName || '');
    const titleEl = document.getElementById('saveBatchTitle');
    if (titleEl) titleEl.textContent = '保存批次';
    modal.style.display = 'flex';
    setTimeout(() => {
        const input = document.getElementById('batchNameInput');
        if (input) input.focus();
    }, 0);
}
