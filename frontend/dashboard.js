const el = id => document.getElementById(id);
let fetching = false;

function nodeRow(node, commitIndex) {
  const row = document.createElement('article');
  row.className = `nodeRow ${node.online ? node.role : 'offline'}`;
  const title = document.createElement('div');
  const name = document.createElement('h3');
  name.textContent = node.id;
  const address = document.createElement('small');
  address.textContent = node.url.replace('http://', '');
  title.append(name, address);
  const role = document.createElement('span');
  role.className = 'nodeRole';
  const lag = node.online ? Math.max(0, commitIndex - node.commit_index) : null;
  role.textContent = !node.online ? 'Offline' : lag > 0 ? `${node.role} / catching up` : node.role;
  row.append(title, role);
  for (const [label, val] of [['Term', node.term], ['Log entries', node.log_length], ['Commit index', node.commit_index], ['Behind', lag]]) {
    const stat = document.createElement('dl');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label; dd.textContent = val ?? '-';
    stat.append(dt, dd); row.append(stat);
  }
  return row;
}

async function fetchData() {
  if (fetching) return;
  fetching = true;
  el('refreshBtn').disabled = true;
  try {
    const res = await fetch('/api/dashboard-data', { signal: AbortSignal.timeout(2500), cache: 'no-store' });
    if (!res.ok) throw new Error('gateway unavailable');
    const data = await res.json();
    const cfg = data.cluster;
    el('connPill').className = 'connPill online';
    el('connText').textContent = 'Live';
    el('clusterState').textContent = cfg.hasQuorum ? 'Ready to commit' : cfg.onlineCount < 2 ? 'Waiting for a majority' : 'Electing a leader';
    el('clusterNote').textContent = cfg.hasQuorum
      ? cfg.recovering ? 'Drawing can continue. A replica is catching up.' : cfg.onlineCount === 3 ? 'All three replicas are online and caught up.' : 'Two replicas are available. Drawing can continue.'
      : 'New marks stay pending until two replicas can agree.';
    el('quorumMark').textContent = `${cfg.onlineCount}/3`;
    el('updatedAt').textContent = `Updated ${new Date().toLocaleTimeString('en-GB')}`;
    el('onlineCount').textContent = `${cfg.onlineCount} / 3`;
    el('leaderName').textContent = cfg.leaderId || '-';
    el('currentTerm').textContent = cfg.term ?? '-';
    el('pendingCount').textContent = data.pendingStrokes;
    el('clientCount').textContent = data.connectedClients;
    el('commitCount').textContent = data.metrics.strokesCommitted;
    el('failedCount').textContent = data.metrics.failedOps;
    el('replayIndex').textContent = data.lastIndex;
    el('nodeList').replaceChildren(...data.replicas.map(node => nodeRow(node, cfg.commitIndex)));
    const events = data.eventLog.map(event => {
      const li = document.createElement('li');
      const time = document.createElement('time');
      time.dateTime = event.time; time.textContent = new Date(event.time).toLocaleTimeString('en-GB');
      const msg = document.createElement('span'); msg.textContent = event.msg;
      li.append(time, msg); return li;
    });
    if (events.length) el('eventLog').replaceChildren(...events);
  } catch {
    el('connPill').className = 'connPill offline';
    el('connText').textContent = 'Disconnected';
    el('clusterState').textContent = 'Gateway unavailable';
    el('clusterNote').textContent = 'Showing the last update. Retrying automatically.';
    el('quorumMark').textContent = '?';
  } finally { fetching = false; el('refreshBtn').disabled = false; }
}
el('refreshBtn').onclick = fetchData;
fetchData();
setInterval(fetchData, 1000);
