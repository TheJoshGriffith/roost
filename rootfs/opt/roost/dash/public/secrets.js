'use strict';
/* =========================================================================
   roost dashboard: Keys & secrets page (#/secrets).
   Uses the shared helpers from ui.js (h, icon, openSheet, copyButton, ago...)
   and api()/toast() from app.js. Secret values are write-only: the server
   never sends them back, so edit forms leave the value blank to keep it.
   ========================================================================= */

const SECRET_PRESETS = [
  { id: 'custom', label: 'Custom', name: '', description: '' },
  { id: 'github', label: 'GitHub token', name: 'GH_TOKEN', description: 'GitHub token: gh CLI and git over HTTPS', gitHost: 'github.com', gitUser: 'oauth2',
    help: 'gh and git both pick it up. A fine-grained token limited to the repositories roost works on is safest.',
    links: [
      { href: 'https://github.com/settings/personal-access-tokens/new', label: 'Create a fine-grained token (recommended)' },
      { href: 'https://github.com/settings/tokens/new?scopes=repo,read:org,workflow,gist&description=roost', label: 'Create a classic token with gh\u2019s scopes' },
    ] },
  { id: 'gitlab', label: 'GitLab token', name: 'GITLAB_TOKEN', description: 'GitLab token: glab CLI and git over HTTPS', gitHost: 'gitlab.com', gitUser: 'oauth2' },
  { id: 'ha', label: 'Home Assistant', name: 'HASS_TOKEN', description: 'Home Assistant long-lived access token', help: 'Create one in Home Assistant under your profile → Security → Long-lived access tokens.' },
  { id: 'api', label: 'API key', name: 'API_KEY', description: '' },
];

const Secrets = {
  data: null,
  tools: null,
  loading: false,
  changedSinceRestart: false,

  async refresh(forceTools) {
    if (this.loading) return;
    this.loading = true;
    // CLI status involves network calls to GitHub/GitLab: render the rest first.
    api('GET', 'api/secrets/tools' + (forceTools ? '?refresh=1' : ''))
      .then((t) => { this.tools = t; this.render(); })
      .catch(() => {});
    try {
      this.data = await api('GET', 'api/secrets');
    } catch (e) {
      toast(e.message);
    } finally {
      this.loading = false;
    }
    this.render();
  },

  changed(msg) {
    this.changedSinceRestart = true;
    if (msg) toast(msg);
    this.tools = null;
    this.refresh(true);
  },

  render() {
    const root = $('#secrets');
    if (!root) return;
    const d = this.data;
    if (!d) { root.replaceChildren(h('p', { class: 'muted', style: 'padding:16px' }, 'Loading…')); return; }
    const sec = (title, aside, ...kids) => h('section', null, h('div', { class: 'sec-h' }, h('h2', null, title), aside ? h('span', { class: 'aside' }, aside) : null), ...kids);

    const intro = h('div', { class: 'card card-pad sx-intro' },
      h('p', null, 'Keys and tokens the agents can use while they work: SSH keys for cloning and pushing, and secrets they get as environment variables.'),
      h('p', { class: 'small-print' }, icon('shield', 14), ' Values are write-only here. But anything an agent can use, it can also read, so prefer narrowly scoped tokens (e.g. a fine-grained GitHub token for specific repos).'));

    // ---------------------------------------------------------- CLI tools
    const t = this.tools;
    const toolRow = (name, cli, st, connect, extra) => {
      const state = !st ? { dot: '', text: 'Checking\u2026' }
        : !st.installed ? { dot: 'bad', text: `${cli} isn\u2019t installed` }
          : st.signedIn ? { dot: 'ok', text: `Signed in to ${st.host} as ${st.user || 'unknown'}${st.source ? ` (${st.source === 'oauth_token' ? 'browser sign-in' : st.source})` : ''}` }
            : st.error ? { dot: 'bad', text: st.error }
              : { dot: 'warn', text: `Not signed in to ${st.host}` };
      return h('li', { class: 'sx-row' },
        h('div', { class: 'sx-main' },
          h('div', { class: 'sx-title' }, h('span', null, name), h('span', { class: 'mono sx-meta' }, cli + (st && st.version ? ' ' + st.version : ''))),
          h('div', { class: 'sx-status' }, h('span', { class: 'dot ' + state.dot }), h('span', null, state.text))),
        h('div', { class: 'sx-actions' },
          st && st.signedIn
            ? h('button', { type: 'button', class: 'btn ghost small', onclick: connect }, 'Change')
            : h('button', { type: 'button', class: 'btn primary small', onclick: connect }, 'Connect'),
          extra || null));
    };
    const cliCard = h('div', { class: 'card' },
      h('ul', { class: 'sx-list' },
        toolRow('GitHub', 'gh', t && t.gh, () => this.connectGitHub(),
          t && t.gh && !t.gh.signedIn ? h('a', { class: 'btn ghost small', href: 'term/?arg=gh-login', target: '_blank', title: 'Sign in with a one-time code in your browser instead of a token' }, 'Browser sign-in') : null),
        toolRow('GitLab', 'glab', t && t.glab, () => this.connectGitLab())),
      h('div', { class: 'card-pad sx-foot' },
        h('span', { class: 'small-print', style: 'flex:1' }, 'Agents can use ', h('code', null, 'gh'), ' and ', h('code', null, 'glab'), ' once they\u2019re connected. Tokens are stored as secrets below.'),
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => { this.tools = null; this.render(); this.refresh(true); } }, icon('refresh', 14), 'Check again')));

    // ---------------------------------------------------------- SSH keys
    const keyRow = (k) => h('li', { class: 'sx-row' },
      h('div', { class: 'sx-main' },
        h('div', { class: 'sx-title' }, icon('key', 15), h('span', { class: 'mono' }, k.name), k.missing ? h('span', { class: 'badge bad' }, 'file missing') : null, k.imported ? h('span', { class: 'badge' }, 'imported') : null),
        h('div', { class: 'sx-meta' }, k.type ? `${k.type}${k.bits ? ' ' + k.bits : ''}` : '', k.fingerprint ? h('span', { class: 'mono' }, ' · ' + k.fingerprint) : null),
        h('div', { class: 'sx-chips' }, k.hosts.length ? k.hosts.map((x) => h('span', { class: 'badge' }, x)) : h('span', { class: 'badge warn' }, 'any host'))),
      h('div', { class: 'sx-actions' },
        k.publicKey ? copyButton(() => k.publicKey, 'Copy public key', 'Copy the public key for ' + k.name) : null,
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => this.testKey(k) }, 'Test'),
        h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'More actions for ' + k.name, onclick: (e) => openMenu(e.currentTarget, [
          { label: 'Show public key', icon: 'key', onClick: () => this.showPublicKey(k) },
          { label: 'Edit hosts', icon: 'pencil', onClick: () => this.editHosts(k) },
          'sep',
          { label: 'Delete key', icon: 'trash', danger: true, onClick: () => this.deleteKey(k) },
        ], k.name) }, icon('more', 18))));

    const keys = h('div', { class: 'card' },
      d.keys.length ? h('ul', { class: 'sx-list' }, d.keys.map(keyRow))
        : h('div', { class: 'card-pad sx-empty' }, h('p', null, 'No SSH keys yet.'), h('p', { class: 'small-print' }, 'Generate one and add its public key to GitHub (Settings → SSH keys, or a repository’s Deploy keys). Agents can then clone and push over SSH.')),
      h('div', { class: 'card-pad sx-foot' },
        h('button', { type: 'button', class: 'btn primary small', onclick: () => this.generateKey() }, icon('plus', 15), 'Generate key'),
        h('button', { type: 'button', class: 'btn small', onclick: () => this.importKey() }, 'Import key')));

    // ---------------------------------------------------------- env secrets
    const envRow = (s) => h('li', { class: 'sx-row' },
      h('div', { class: 'sx-main' },
        h('div', { class: 'sx-title' }, h('span', { class: 'mono' }, s.name), s.caution ? h('span', { class: 'badge warn', title: s.caution }, 'affects sign-in') : null),
        s.description ? h('div', { class: 'sx-desc' }, s.description) : null,
        h('div', { class: 'sx-chips' },
          s.gitHost ? h('span', { class: 'badge' }, icon('branch', 12), 'git: ' + s.gitHost) : null,
          h('span', { class: 'sx-meta' }, `${s.length} characters · updated ${ago(s.updated) || 'just now'}`))),
      h('div', { class: 'sx-actions' },
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => this.editSecret(s) }, 'Edit'),
        h('button', { type: 'button', class: 'btn ghost small danger', onclick: () => this.deleteSecret(s) }, 'Delete')));

    const envs = h('div', { class: 'card' },
      d.env.length ? h('ul', { class: 'sx-list' }, d.env.map(envRow))
        : h('div', { class: 'card-pad sx-empty' }, h('p', null, 'No secrets yet.'), h('p', { class: 'small-print' }, 'Add tokens and API keys the agents need, like GH_TOKEN for GitHub. Each becomes an environment variable, and a token can double as a git-over-HTTPS credential.')),
      h('div', { class: 'card-pad sx-foot' },
        h('button', { type: 'button', class: 'btn primary small', onclick: () => this.editSecret(null) }, icon('plus', 15), 'Add secret')));

    // ---------------------------------------------------------- where they apply
    const rc = (App.status && App.status.rc && App.status.rc.projects) || [];
    const apply = h('div', { class: 'card card-pad sx-apply' + (this.changedSinceRestart ? ' is-changed' : '') },
      h('p', null, h('b', null, 'Where they apply. '), 'New chats, terminals, SSH sessions and git commands pick up changes straight away. Chats already running, the Remote Control server and VS Code keep the old values until they restart.'),
      rc.length ? h('div', { class: 'sx-foot', style: 'padding:0;margin-top:10px' },
        h('button', { type: 'button', class: 'btn small' + (this.changedSinceRestart ? ' primary' : ''), onclick: () => this.restartRc(rc) }, icon('refresh', 15), 'Restart Remote Control'),
        h('span', { class: 'small-print' }, 'Agents can run ', h('code', null, 'roost-secrets'), ' to see what’s available.')) : null);

    root.replaceChildren(
      intro,
      sec('CLI tools', null, cliCard),
      sec('SSH keys', d.keys.length ? plural(d.keys.length, 'key') : null, keys),
      sec('Secrets', d.env.length ? plural(d.env.length, 'secret') : null, envs),
      apply);
  },

  // ---------------------------------------------------------- actions: secrets
  editSecret(s, presetId) {
    const isNew = !s;
    const fld = (label, input, help) => h('div', { class: 'field' }, h('label', { class: 'lbl', for: input.id || null }, label), input, help ? h('p', { class: 'help' }, help) : null);
    const preset = h('select', { class: 'input', id: 'sx-preset' }, SECRET_PRESETS.map((p) => h('option', { value: p.id }, p.label)));
    const name = h('input', { class: 'input mono', id: 'sx-name', value: s ? s.name : '', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'GH_TOKEN', disabled: !isNew });
    const value = h('input', { class: 'input mono', id: 'sx-value', type: 'password', autocomplete: 'new-password', spellcheck: 'false', placeholder: isNew ? 'Paste the token or secret' : 'Leave blank to keep the current value' });
    const reveal = h('button', { type: 'button', class: 'btn ghost small', onclick: () => { value.type = value.type === 'password' ? 'text' : 'password'; reveal.textContent = value.type === 'password' ? 'Show' : 'Hide'; } }, 'Show');
    const desc = h('input', { class: 'input', id: 'sx-desc', value: s ? s.description : '', autocomplete: 'off', placeholder: 'What it’s for (agents see this, not the value)' });
    const gitOn = h('input', { type: 'checkbox', class: 'switch', id: 'sx-git', checked: !!(s && s.gitHost) });
    const gitHost = h('input', { class: 'input mono', id: 'sx-githost', value: (s && s.gitHost) || '', placeholder: 'github.com', autocomplete: 'off' });
    const gitUser = h('input', { class: 'input mono', id: 'sx-gituser', value: (s && s.gitUser) || '', placeholder: 'oauth2', autocomplete: 'off' });
    const gitFields = h('div', { class: 'sx-git', hidden: !gitOn.checked }, fld('Host', gitHost), fld('Username', gitUser, 'Usually anything works with a token; GitLab prefers oauth2.'));
    gitOn.addEventListener('change', () => { gitFields.hidden = !gitOn.checked; });
    const presetHelp = h('div', { class: 'help sx-preset-help', hidden: true });
    const caution = h('p', { class: 'sx-caution', hidden: true });
    const syncCaution = () => {
      const c = this.data && this.data.caution[name.value.trim()];
      caution.hidden = !c;
      caution.replaceChildren(icon('alert', 14), h('span', null, c || ''));
    };
    name.addEventListener('input', () => { name.value = name.value.replace(/[^A-Za-z0-9_]/g, '_'); syncCaution(); });
    preset.addEventListener('change', () => {
      const p = SECRET_PRESETS.find((x) => x.id === preset.value);
      if (!p) return;
      if (p.name) name.value = p.name;
      if (p.description) desc.value = p.description;
      gitOn.checked = !!p.gitHost; gitFields.hidden = !p.gitHost;
      gitHost.value = p.gitHost || ''; gitUser.value = p.gitUser || '';
      presetHelp.hidden = !p.help && !p.links;
      presetHelp.replaceChildren(p.help ? h('p', null, p.help) : '', ...(p.links || []).map((l) => h('p', null, h('a', { href: l.href, target: '_blank', rel: 'noopener' }, l.label, ' ', icon('external', 12)))));
      syncCaution();
    });
    if (isNew && presetId) { preset.value = presetId; preset.dispatchEvent(new Event('change')); }
    syncCaution();
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const form = h('form', { id: 'sx-form', class: 'form' },
      isNew ? fld('Type', preset) : null, isNew ? presetHelp : null,
      fld('Name', name, isNew ? 'Becomes an environment variable, e.g. $GH_TOKEN.' : null), caution,
      h('div', { class: 'field' }, h('label', { class: 'lbl', for: 'sx-value' }, 'Value'), h('div', { class: 'sx-value' }, value, reveal)),
      fld('Description', desc),
      h('label', { class: 'switch-row', for: 'sx-git' }, h('span', { class: 'grow' }, h('div', { class: 't' }, 'Also use for git over HTTPS'), h('div', { class: 'd' }, 'git clone https://host/… authenticates with this token')), gitOn),
      gitFields, err);
    const save = h('button', { type: 'submit', class: 'btn primary', form: 'sx-form' }, isNew ? 'Add secret' : 'Save');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      const n = isNew ? name.value.trim() : s.name;
      if (!n) { err.textContent = 'Give it a name.'; err.hidden = false; return; }
      if (isNew && !value.value) { err.textContent = 'Paste the value.'; err.hidden = false; return; }
      save.disabled = true;
      try {
        await api('PUT', `api/secrets/env/${encodeURIComponent(n)}`, {
          value: value.value || undefined, description: desc.value.trim(),
          gitHost: gitOn.checked ? gitHost.value.trim() || null : null, gitUser: gitOn.checked ? gitUser.value.trim() || null : null,
        });
        value.value = '';
        $('#sheet').close();
        this.changed(isNew ? `Added ${n}` : `Saved ${n}`);
      } catch (x) { err.textContent = x.message; err.hidden = false; }
      finally { save.disabled = false; }
    });
    openSheet({ title: isNew ? 'Add a secret' : `Edit ${s.name}`, body: form, foot: [h('span', { class: 'spacer', hidden: true }), h('button', { type: 'button', class: 'btn', onclick: () => $('#sheet').close() }, 'Cancel'), save], onClose: () => { value.value = ''; } });
    if (matchMedia('(pointer: fine)').matches) (isNew ? name : value).focus();
  },

  connectGitHub() {
    const existing = this.data && this.data.env.find((x) => x.name === 'GH_TOKEN');
    if (existing) this.editSecret(existing); else this.editSecret(null, 'github');
  },

  connectGitLab() {
    const d = this.data || { env: [] };
    const tok = d.env.find((x) => x.name === 'GITLAB_TOKEN');
    const fld = (label, input, help) => h('div', { class: 'field' }, h('label', { class: 'lbl', for: input.id || null }, label), input, help ? h('p', { class: 'help' }, help) : null);
    const host = h('input', { class: 'input mono', id: 'gl-host', value: (this.tools && this.tools.glab && this.tools.glab.host) || 'gitlab.com', autocomplete: 'off', spellcheck: 'false' });
    const value = h('input', { class: 'input mono', id: 'gl-token', type: 'password', autocomplete: 'new-password', spellcheck: 'false', placeholder: tok ? 'Leave blank to keep the current token' : 'glpat-\u2026' });
    const link = h('a', { target: '_blank', rel: 'noopener' });
    const syncLink = () => {
      const hst = host.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || 'gitlab.com';
      link.href = `https://${hst}/-/user_settings/personal_access_tokens?name=roost&scopes=api,read_repository,write_repository`;
      link.replaceChildren(`Create a token on ${hst} (name and scopes filled in)`, ' ', icon('external', 12));
    };
    host.addEventListener('input', syncLink);
    syncLink();
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const form = h('form', { id: 'gl-form', class: 'form' },
      fld('GitLab host', host, 'gitlab.com, or your own instance, e.g. gitlab.example.com.'),
      h('div', { class: 'help sx-preset-help' }, h('p', null, link), h('p', null, 'Scopes: api (for glab), read_repository and write_repository (for git over HTTPS).')),
      fld('Personal access token', value),
      err);
    const save = h('button', { type: 'submit', class: 'btn primary', form: 'gl-form' }, tok ? 'Save' : 'Connect');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      const hst = host.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase() || 'gitlab.com';
      if (!tok && !value.value) { err.textContent = 'Paste the token.'; err.hidden = false; return; }
      save.disabled = true;
      try {
        await api('PUT', 'api/secrets/env/GITLAB_TOKEN', { value: value.value || undefined, description: `GitLab token for ${hst}: glab CLI and git over HTTPS`, gitHost: hst, gitUser: 'oauth2' });
        if (hst !== 'gitlab.com') await api('PUT', 'api/secrets/env/GITLAB_HOST', { value: hst, description: 'GitLab instance glab talks to' });
        else if (d.env.some((x) => x.name === 'GITLAB_HOST')) await api('DELETE', 'api/secrets/env/GITLAB_HOST');
        value.value = '';
        $('#sheet').close();
        this.changed(`GitLab connected (${hst})`);
      } catch (x) { err.textContent = x.message; err.hidden = false; }
      finally { save.disabled = false; }
    });
    openSheet({ title: tok ? 'GitLab connection' : 'Connect GitLab', body: form, foot: [h('span', { class: 'spacer', hidden: true }), h('button', { type: 'button', class: 'btn', onclick: () => $('#sheet').close() }, 'Cancel'), save], onClose: () => { value.value = ''; } });
    if (matchMedia('(pointer: fine)').matches) (tok ? value : host).focus();
  },

  async deleteSecret(s) {
    if (!confirm(`Delete ${s.name}? Agents will no longer have it.`)) return;
    try { await api('DELETE', `api/secrets/env/${encodeURIComponent(s.name)}`); this.changed(`Deleted ${s.name}`); } catch (e) { toast(e.message); }
  },

  // ---------------------------------------------------------- actions: SSH keys
  keyForm({ title, submit, importing }) {
    const fld = (label, input, help) => h('div', { class: 'field' }, h('label', { class: 'lbl', for: input.id || null }, label), input, help ? h('p', { class: 'help' }, help) : null);
    const name = h('input', { class: 'input mono', id: 'sk-name', autocomplete: 'off', spellcheck: 'false', placeholder: 'github' });
    const hosts = h('input', { class: 'input mono', id: 'sk-hosts', autocomplete: 'off', spellcheck: 'false', placeholder: 'github.com', value: 'github.com' });
    const pk = importing ? h('textarea', { class: 'input mono sx-pem', id: 'sk-pk', rows: '6', spellcheck: 'false', autocomplete: 'off', placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----' }) : null;
    const pass = importing ? h('input', { class: 'input', id: 'sk-pass', type: 'password', autocomplete: 'off', placeholder: 'Only if the key has one' }) : null;
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const form = h('form', { id: 'sk-form', class: 'form' },
      fld('Name', name, 'A label for this key, e.g. github or work-gitlab.'),
      fld('Use for hosts', hosts, 'Comma-separated. Leave empty to offer this key to any host.'),
      importing ? fld('Private key', pk, 'Stored unencrypted in roost so agents can use it. Use a key made for roost, not your personal one.') : null,
      importing ? fld('Passphrase', pass) : null,
      err);
    const btn = h('button', { type: 'submit', class: 'btn primary', form: 'sk-form' }, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      try {
        const k = await api('POST', 'api/secrets/keys', { name: name.value.trim(), hosts: hosts.value, privateKey: pk ? pk.value : undefined, passphrase: pass ? pass.value || undefined : undefined });
        if (pk) pk.value = '';
        if (pass) pass.value = '';
        $('#sheet').close();
        this.changed(importing ? `Imported ${k.name}` : `Generated ${k.name}`);
        if (!importing) this.showPublicKey(k, true);
      } catch (x) { err.textContent = x.message; err.hidden = false; }
      finally { btn.disabled = false; }
    });
    openSheet({ title, body: form, foot: [h('span', { class: 'spacer', hidden: true }), h('button', { type: 'button', class: 'btn', onclick: () => $('#sheet').close() }, 'Cancel'), btn], onClose: () => { if (pk) pk.value = ''; if (pass) pass.value = ''; } });
    if (matchMedia('(pointer: fine)').matches) name.focus();
  },

  generateKey() { this.keyForm({ title: 'Generate an SSH key', submit: 'Generate' }); },
  importKey() { this.keyForm({ title: 'Import an SSH key', submit: 'Import', importing: true }); },

  showPublicKey(k, fresh) {
    const host = k.hosts[0] || 'github.com';
    const where = /gitlab/.test(host) ? 'GitLab: Preferences → SSH Keys, or a project’s Settings → Repository → Deploy keys'
      : /github/.test(host) ? 'GitHub: Settings → SSH and GPG keys, or a repository’s Settings → Deploy keys (tick “Allow write access” to push)'
        : `the account or repository settings on ${host}`;
    openSheet({
      title: fresh ? `${k.name} is ready` : `${k.name}: public key`, wide: true,
      body: h('div', { class: 'form' },
        h('p', null, 'Add this public key to ', where, '.'),
        h('pre', { class: 'sx-pub', tabindex: '0' }, k.publicKey),
        h('p', { class: 'small-print' }, 'Then use ', h('b', null, 'Test'), ' to check it works. The private key never leaves roost.')),
      foot: [h('span', { class: 'spacer', hidden: true }), copyButton(() => k.publicKey, 'Copy public key', 'Copy public key'), h('button', { type: 'button', class: 'btn', onclick: () => $('#sheet').close() }, 'Done')],
    });
  },

  editHosts(k) {
    const input = h('input', { class: 'input mono', id: 'sk-edit-hosts', value: k.hosts.join(', '), autocomplete: 'off', spellcheck: 'false' });
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const form = h('form', { id: 'sk-hosts-form', class: 'form' }, h('div', { class: 'field' }, h('label', { class: 'lbl', for: 'sk-edit-hosts' }, 'Use for hosts'), input, h('p', { class: 'help' }, 'Comma-separated. Leave empty to offer this key to any host.')), err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('PATCH', `api/secrets/keys/${encodeURIComponent(k.name)}`, { hosts: input.value }); $('#sheet').close(); this.changed('Saved'); } catch (x) { err.textContent = x.message; err.hidden = false; }
    });
    openSheet({ title: `Hosts for ${k.name}`, body: form, foot: [h('span', { class: 'spacer', hidden: true }), h('button', { type: 'button', class: 'btn', onclick: () => $('#sheet').close() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary', form: 'sk-hosts-form' }, 'Save')] });
  },

  async deleteKey(k) {
    if (!confirm(`Delete the SSH key ${k.name}? This can't be undone; remove its public key from ${k.hosts[0] || 'your git host'} too.`)) return;
    try { await api('DELETE', `api/secrets/keys/${encodeURIComponent(k.name)}`); this.changed(`Deleted ${k.name}`); } catch (e) { toast(e.message); }
  },

  async testKey(k) {
    const host = k.hosts[0] || 'github.com';
    toast(`Testing ${k.name} against ${host}…`);
    try {
      const r = await api('POST', `api/secrets/keys/${encodeURIComponent(k.name)}/test`, { host });
      openSheet({
        title: r.ok ? `${k.name} works with ${r.host}` : `${k.name} didn’t authenticate with ${r.host}`, wide: true,
        body: h('div', { class: 'form' },
          h('p', { class: 'sx-result ' + (r.ok ? 'ok' : 'bad') }, icon(r.ok ? 'check' : 'alert', 16), r.ok ? 'Authenticated. Agents can clone and push over SSH.' : 'Not authenticated. Check the public key is added on ' + r.host + '.'),
          h('pre', { class: 'log-pre' }, r.output)),
        foot: [h('span', { class: 'spacer', hidden: true }), h('button', { type: 'button', class: 'btn', onclick: () => $('#sheet').close() }, 'Close')],
      });
    } catch (e) { toast(e.message); }
  },

  async restartRc(projects) {
    for (const p of projects) {
      try { await api('POST', `api/rc/${encodeURIComponent(p.session)}/restart`); } catch {}
    }
    this.changedSinceRestart = false;
    toast('Remote Control restarting with the new secrets (~15s)');
    this.render();
  },
};
