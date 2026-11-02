/* ============================================================
   P2P Transfer — Otomatik Sinyalleşme (PeerJS)
   - QR içeriği: sadece "p2p-xxxxxxxxxx" (~14 karakter)
   - Telefon QR'ı okur okumaz WebRTC P2P bağlantı otomatik kurulur
   - Veri: DTLS ile uçtan uca şifreli DataChannel
   ============================================================ */

(() => {
  'use strict';

  const ROLE = document.body.dataset.role; // "desktop" | "mobile"
  const CHUNK_SIZE = 16 * 1024;            // 16 KB
  const HIGH_WATER = 1024 * 1024;          // 1 MB buffer sınırı

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const statusBadge = $('status');
  const qrSection   = $('qrSection');
  const scanSection = $('scanSection');
  const chatSection = $('chatSection');
  const chatLog     = $('chatLog');
  const msgForm     = $('msgForm');
  const msgInput    = $('msgInput');
  const fileInput   = $('fileInput');
  const progressArea= $('progressArea');
  const progressBar = $('progressBar');
  const progressPct = $('progressPct');
  const progressLabel = $('progressLabel');

  // ---- Durum ----
  let peer = null;
  let conn = null;
  let ready = false;
  const incomingFiles = new Map();

  // ---- PeerJS yapılandırması (genel ücretsiz broker) ----
  const PEER_OPTS = {
    host: '0.peerjs.com',
    port: 443,
    secure: true,
    path: '/',
    debug: 0
  };

  // ============================================================
  // UI yardımcıları
  // ============================================================
  function setStatus(text, kind = 'wait') {
    if (!statusBadge) return;
    statusBadge.textContent = text;
    statusBadge.className = 'badge ' +
      (kind === 'ok' ? 'badge-ok' : kind === 'err' ? 'badge-err' : 'badge-wait');
  }

  function showChat() {
    qrSection?.classList.add('hidden');
    scanSection?.classList.add('hidden');
    chatSection?.classList.remove('hidden');
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
  }

  function showProgress(label, pct) {
    progressArea?.classList.remove('hidden');
    if (progressLabel) progressLabel.textContent = label;
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    if (progressBar) progressBar.value = p;
    if (progressPct) progressPct.textContent = p + '%';
  }
  function hideProgress() {
    progressArea?.classList.add('hidden');
    if (progressBar) progressBar.value = 0;
    if (progressPct) progressPct.textContent = '0%';
  }

  // ============================================================
  // Gelen veri
  // ============================================================
  function handleIncoming(data) {
    if (typeof data === 'string') {
      let p;
      try { p = JSON.parse(data); } catch { return; }

      if (p.t === 'text') {
        addMessage(p.text, 'them', new Date(p.ts).toLocaleTimeString('tr-TR'));
      } else if (p.t === 'file-start') {
        incomingFiles.set(p.id, {
          name: p.name, size: p.size, mime: p.mime,
          chunks: [], received: 0
        });
        showProgress(`Alınıyor: ${p.name}`, 0);
      } else if (p.t === 'file-end') {
        const f = incomingFiles.get(p.id);
        if (!f) return;
        const blob = new Blob(f.chunks, { type: f.mime || 'application/octet-stream' });
        addBlobMessage(blob, 'them', f.name, f.mime || '');
        incomingFiles.delete(p.id);
        hideProgress();
      }
      return;
    }

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

  // ============================================================
  // PeerJS bağlantısı
  // ============================================================
  function wireConnection(c) {
    conn = c;
    c.on('open', () => {
      ready = true;
      showChat();
      addMessage('🔐 P2P bağlantı kuruldu (DTLS ile uçtan uca şifreli).', 'them');
    });
    c.on('data', handleIncoming);
    c.on('close', () => {
      ready = false;
      setStatus('Bağlantı kapandı', 'err');
    });
    c.on('error', (err) => {
      setStatus('Hata: ' + (err.type || 'bilinmeyen'), 'err');
    });
  }

  function sendText(text) {
    if (!ready) return;
    conn.send(JSON.stringify({ t: 'text', text, ts: Date.now() }));
    addMessage(text, 'me', new Date().toLocaleTimeString('tr-TR'));
  }

  async function sendFile(file) {
    if (!ready) return;
    const id = crypto.randomUUID();
    const idBytes = new TextEncoder().encode(id); // 36 byte

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
      const dchan = conn.dataChannel;
      if (dchan && dchan.bufferedAmount > HIGH_WATER) {
        await new Promise((res) => {
          const check = () => {
            if (!dchan || dchan.bufferedAmount <= HIGH_WATER) res();
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
  function initDesktop() {
    setStatus('Oturum hazırlanıyor…', 'wait');
    const peerId = 'p2p-' + Math.random().toString(36).slice(2, 12);

    peer = new Peer(peerId, PEER_OPTS);

    peer.on('open', (id) => {
      setStatus('QR hazır — telefonla okutun', 'wait');
      const qrBox = $('qrcode');
      if (qrBox && window.QRCode) {
        qrBox.innerHTML = '';
        new QRCode(qrBox, {
          text: id,             // sadece kısa ID
          width: 280,
          height: 280,
          correctLevel: QRCode.CorrectLevel.M
        });
      }
      const lbl = $('peerIdLabel');
      if (lbl) lbl.textContent = id;
    });

    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        peer.destroy();
        setTimeout(initDesktop, 500);
        return;
      }
      setStatus('Sinyal hatası: ' + err.type, 'err');
    });

    peer.on('connection', (c) => wireConnection(c));
  }

  // ============================================================
  // MOBİL: QR oku → peer aç → bağlan
  // ============================================================
 async function initMobile() {
  setStatus('Kamera açılıyor…', 'wait');
  const video = $('scanner');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('Kamera desteklenmiyor (HTTPS gerekli)', 'err');
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    });
  } catch (e) {
    setStatus('Kamera erişimi reddedildi', 'err');
    alert('Kamera hatası: ' + e.name + ' - ' + e.message);
    return;
  }

  // ★ KRİTİK DÜZELTME 1: track'in etkin olduğunu zorunlu olarak doğrula
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    setStatus('Video track bulunamadı', 'err');
    return;
  }
  videoTrack.enabled = true;  // enabled=false ise tüm kareler siyah olur

  // ★ KRİTİK DÜZELTME 2: video öğesine ata ve meta verilerin yüklenmesini bekle
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.muted = true;
  video.autoplay = true;

  // loadeddata bekle (videoWidth/Height'nin geçerli olduğundan emin ol)
  await new Promise((resolve, reject) => {
    if (video.readyState >= 2) return resolve();
    const onLoaded = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('video load error')); };
    const cleanup = () => {
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('loadeddata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
    setTimeout(() => { cleanup(); reject(new Error('video load timeout')); }, 8000);
  });

  // ★ KRİTİK DÜZELTME 3: oynatmayı zorla ve gerçekten çalıştığını doğrula
  try {
    await video.play();
  } catch (e) {
    // Mobil tarayıcı otomatik oynatmayı engelleyebilir, kullanıcı dokunuşunu bekle
    setStatus('Kamerayı başlatmak için ekrana dokunun', 'wait');
    await new Promise((resolve) => {
      const onTouch = () => {
        document.removeEventListener('touchstart', onTouch);
        document.removeEventListener('click', onTouch);
        video.play().then(resolve).catch(resolve);
      };
      document.addEventListener('touchstart', onTouch, { once: true });
      document.addEventListener('click', onTouch, { once: true });
    });
  }

  // playing olayını bekle (gerçekten kare ürettiğinden emin ol)
  if (video.paused || video.ended) {
    await new Promise((resolve) => {
      video.addEventListener('playing', resolve, { once: true });
      setTimeout(resolve, 3000);
    });
  }

  // Son kontrol: videoWidth geçerli mi
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    setStatus('Kamera görüntü üretmedi', 'err');
    return;
  }

  setStatus('QR aranıyor…', 'wait');

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let lastScan = 0;

  const interval = setInterval(() => {
    // Her taramada video'nun hala geçerli olduğunu kontrol et
    if (video.readyState < 2 || video.videoWidth === 0) return;

    const now = performance.now();
    if (now - lastScan < 200) return;  // 200ms tarama aralığı
    lastScan = now;

    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (!window.jsQR) return;
    const code = jsQR(img.data, img.width, img.height, {
      inversionAttempts: 'dontInvert'
    });

    if (code && code.data && code.data.startsWith('p2p-')) {
      clearInterval(interval);
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      connectToPeer(code.data.trim());
    }
  }, 200);
}

  function connectToPeer(targetId) {
    setStatus('Bağlanıyor…', 'wait');
    const myId = 'p2p-' + Math.random().toString(36).slice(2, 12);

    peer = new Peer(myId, PEER_OPTS);

    peer.on('open', () => {
      const c = peer.connect(targetId, { reliable: true });
      wireConnection(c);
    });

    peer.on('error', (err) => {
      setStatus('Bağlantı hatası: ' + err.type, 'err');
    });
  }

  // ============================================================
  // Form olayları
  // ============================================================
  msgForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = msgInput.value.trim();
    if (!text) return;
    sendText(text);
    msgInput.value = '';
    msgInput.focus();
  });

  fileInput?.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    for (const f of files) await sendFile(f);
    fileInput.value = '';
  });

  // ============================================================
  // Başlat
  // ============================================================
  if (ROLE === 'desktop') initDesktop();
  else if (ROLE === 'mobile') initMobile();

  // Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
