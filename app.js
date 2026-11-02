/* ============================================================
   P2P Transfer — Otomatik Sinyalleşme (PeerJS)
   - QR'a yalnızca kısa peer ID gömülür (~13 karakter)
   - Telefon QR'ı okur okumaz P2P bağlantı kendiliğinden kurulur
   - Veri: WebRTC DataChannel, DTLS ile uçtan uca şifreli
   - Sinyal broker'ı yalnızca eşleştirme yapar; içerik akmaz
   ============================================================ */

(() => {
  'use strict';

  const ROLE = document.body.dataset.role; // "desktop" | "mobile"
  const CHUNK_SIZE = 16 * 1024;
  const HIGH_WATER = 1024 * 1024;

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const statusBadge = $('status');
  const qrSection = $('qrSection');
  const scanSection = $('scanSection');
  const chatSection = $('chatSection');
  const chatLog = $('chatLog');
  const msgForm = $('msgForm');
  const msgInput = $('msgInput');
  const fileInput = $('fileInput');
  const progressArea = $('progressArea');
  const progressBar = $('progressBar');
  const progressPct = $('progressPct');
  const progressLabel = $('progressLabel');

  // ---- PeerJS / WebRTC ----
  let peer = null;
  let conn = null;              // PeerJS DataConnection
  let dataChannelReady = false;

  const incomingFiles = new Map();

  // ---- UI ----
  function setStatus(text, kind = 'wait') {
    statusBadge.textContent = text;
    statusBadge.className = 'badge ' +
      (kind === 'ok' ? 'badge-ok' : kind === 'err' ? 'badge-err' : 'badge-wait');
  }

  function showChat() {
    qrSection?.classList.add('hidden');
    scanSection?.classList.add('hidden');
    chatSection.classList.remove('hidden');
    setStatus('Bağlı • Uçtan uca şifreli', 'ok');
  }

  function addMessage(text, who, meta) {
    const div = document.createElement('div');
    div.className = 'msg ' + (who === 'me' ? 'me' : 'them');
    div.textContent = text;
    if (meta) {
      const m = document.createElement('span');
      m.className = 'meta';
      m.textContent = meta;
      div.appendChild(m);
    }
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    return div;
  }

  function addBlobMessage(blob, who, filename, mime) {
    const div = document.createElement('div');
    div.className = 'msg ' + (who === 'me' ? 'me' : 'them');
    const url = URL.createObjectURL(blob);

    if (mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = url; img.alt = filename;
      div.appendChild(img);
    } else if (mime.startsWith('video/')) {
      const v = document.createElement('video');
      v.src = url; v.controls = true; v.playsInline = true;
      div.appendChild(v);
    } else if (mime.startsWith('audio/')) {
      const a = document.createElement('audio');
      a.src = url; a.controls = true;
      div.appendChild(a);
    }

    const dl = document.createElement('a');
    dl.href = url;
    dl.download = filename;
    dl.className = 'dl';
    dl.textContent = '⬇ İndir — ' + filename;
    div.appendChild(dl);

    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    return div;
  }

  function showProgress(label, pct) {
    progressArea.classList.remove('hidden');
    progressLabel.textContent = label;
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    progressBar.value = p;
    progressPct.textContent = p + '%';
  }
  function hideProgress() {
    progressArea.classList.add('hidden');
    progressBar.value = 0;
    progressPct.textContent = '0%';
  }

  // ---- Gelen veri ----
  function handleIncoming(data) {
    if (typeof data === 'string') {
      let payload;
      try { payload = JSON.parse(data); } catch { return; }

      if (payload.t === 'text') {
        addMessage(payload.text, 'them',
          new Date(payload.ts).toLocaleTimeString('tr-TR'));
      } else if (payload.t === 'file-start') {
        incomingFiles.set(payload.id, {
          name: payload.name,
          size: payload.size,
          mime: payload.mime,
          chunks: [],
          received: 0
        });
        showProgress(`Alınıyor: ${payload.name}`, 0);
      } else if (payload.t === 'file-end') {
        const f = incomingFiles.get(payload.id);
        if (!f) return;
        const blob = new Blob(f.chunks, { type: f.mime || 'application/octet-stream' });
        addBlobMessage(blob, 'them', f.name, f.mime || '');
        incomingFiles.delete(payload.id);
        hideProgress();
      }
      return;
    }

    // Binary chunk
    if (data instanceof ArrayBuffer) {
      const view = new Uint8Array(data);
      const id = new TextDecoder().decode(view.slice(0, 36));
      const content = data.slice(36);

      const f = incomingFiles.get(id);
      if (!f) return;
      f.chunks.push(content);
      f.received += content.byteLength;

      const pct = f.size ? (f.received / f.size) * 100 : 0;
      showProgress(`Alınıyor: ${f.name}`, pct);
    }
  }

  // ---- PeerJS bağlantısını yapılandır ----
  function wireConnection(c) {
    conn = c;
    c.on('open', () => {
      dataChannelReady = true;
      showChat();
      addMessage('🔐 P2P bağlantı kuruldu (DTLS ile uçtan uca şifreli).', 'them');
    });
    c.on('data', handleIncoming);
    c.on('close', () => {
      dataChannelReady = false;
      setStatus('Bağlantı kapandı', 'err');
    });
    c.on('error', (err) => {
      setStatus('Bağlantı hatası: ' + err.type, 'err');
    });
  }

  // ---- Metin / dosya gönderme ----
  function sendText(text) {
    if (!dataChannelReady) return;
    conn.send(JSON.stringify({ t: 'text', text, ts: Date.now() }));
    addMessage(text, 'me', new Date().toLocaleTimeString('tr-TR'));
  }

  async function sendFile(file) {
    if (!dataChannelReady) return;
    const id = crypto.randomUUID();
    const idBytes = new TextEncoder().encode(id);

    conn.send(JSON.stringify({
      t: 'file-start',
      id,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream'
    }));

    addBlobMessage(file, 'me', file.name, file.type || '');
    showProgress(`Gönderiliyor: ${file.name}`, 0);

    let offset = 0;
    while (offset < file.size) {
      if (conn.dataChannel && conn.dataChannel.bufferedAmount > HIGH_WATER) {
        await new Promise((res) => {
          const check = () => {
            if (!conn.dataChannel || conn.dataChannel.bufferedAmount <= HIGH_WATER) res();
            else setTimeout(check, 40);
          };
          check();
        });
      }

      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buf = await slice.arrayBuffer();

      const combined = new Uint8Array(idBytes.length + buf.byteLength);
      combined.set(idBytes, 0);
      combined.set(new Uint8Array(buf), idBytes.length);

      conn.send(combined.buffer);
      offset += buf.byteLength;

      showProgress(`Gönderiliyor: ${file.name}`, (offset / file.size) * 100);
    }

    conn.send(JSON.stringify({ t: 'file-end', id }));
    hideProgress();
  }

  // ============================================================
  // MASAÜSTÜ: peer aç → kısa ID'yi QR yap
  // ============================================================
  async function initDesktop() {
    setStatus('Oturum hazırlanıyor…', 'wait');

    // Rastgele, kısa peer ID (sadece harf+rakam)
    const peerId = 'p2p-' + Math.random().toString(36).slice(2, 10);

    peer = new Peer(peerId, {
      // Genel PeerJS broker'ı. İsterseniz kendi sunucunuzu da yazabilirsiniz.
      // Bu sunucu YALNIZCA iki peer'ın tanışmasını sağlar; veri akmaz.
    });

    peer.on('open', (id) => {
      setStatus('QR kod hazır — telefonla okutun', 'wait');
      renderQR(id);
    });

    peer.on('error', (err) => {
      setStatus('Sinyal hatası: ' + err.type, 'err');
      if (err.type === 'unavailable-id') {
        // ID çakıştı → yeniden dene
        peer.destroy();
        initDesktop();
      }
    });

    // Mobil bağlanınca
    peer.on('connection', (c) => {
      wireConnection(c);
    });
  }

  function renderQR(id) {
    const qrBox = $('qrcode');
    qrBox.innerHTML = '';
    $('peerIdLabel').textContent = id;
    // eslint-disable-next-line no-undef
    new QRCode(qrBox, {
      text: id,                 // SADECE kısa ID — dev SDP değil!
      width: 280,
      height: 280,
      correctLevel: QRCode.CorrectLevel.M
    });
  }

  // ============================================================
  // MOBİL: QR oku → peer aç → masaüstüne bağlan
  // ============================================================
  async function initMobile() {
    setStatus('Kamera açılıyor…', 'wait');

    const video = $('scanner');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false
      });
    } catch (e) {
      setStatus('Kamera erişimi reddedildi', 'err');
      alert('Kamera erişimi gerekli: ' + e.message);
      return;
    }
    video.srcObject = stream;
    await video.play();

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let scanning = true;
    const tick = () => {
      if (!scanning) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        // eslint-disable-next-line no-undef
        const code = jsQR(img.data, img.width, img.height,
                          { inversionAttempts: 'dontInvert' });
        if (code && code.data && code.data.startsWith('p2p-')) {
          scanning = false;
          stream.getTracks().forEach((t) => t.stop());
          connectToPeer(code.data.trim());
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setStatus('QR aranıyor…', 'wait');
  }

  function connectToPeer(targetPeerId) {
    setStatus('Bağlanıyor…', 'wait');

    // Rastgele kendi ID'miz
    const myId = 'p2p-' + Math.random().toString(36).slice(2, 10);
    peer = new Peer(myId);

    peer.on('open', () => {
      const c = peer.connect(targetPeerId, { reliable: true });
      wireConnection(c);
    });

    peer.on('error', (err) => {
      setStatus('Bağlantı hatası: ' + err.type, 'err');
    });
  }

  // ---- Form / dosya olayları ----
  msgForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = msgInput.value.trim();
    if (!text) return;
    sendText(text);
    msgInput.value = '';
    msgInput.focus();
  });

  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    for (const f of files) await sendFile(f);
    fileInput.value = '';
  });

  // ---- Başlat ----
  if (ROLE === 'desktop') initDesktop();
  else initMobile();

  // ---- Service Worker ----
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
