/* ============================================================
   P2P Transfer — Ortak Uygulama Mantığı
   - Sunucusuz WebRTC (yalnızca SDP takası için manuel QR akışı)
   - Metin + Dosya (chunked) transferi
   - WebRTC: DTLS ile uçtan uca şifreli
   ============================================================ */

(() => {
  'use strict';

  const ROLE = document.body.dataset.role; // "desktop" | "mobile"
  const CHUNK_SIZE = 16 * 1024;            // 16 KB güvenli parça boyutu
  const HIGH_WATER = 1024 * 1024;          // 1 MB buffer sınırı

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

  // ---- WebRTC ----
  let pc = null;
  let dc = null;
  let dataChannelReady = false;

  // Gelen dosya birleştirme durumu
  const incomingFiles = new Map(); // id -> {name,size,mime,chunks:[],received}

  // ---- UI yardımcıları ----
  function setStatus(text, kind = 'wait') {
    statusBadge.textContent = text;
    statusBadge.className = 'badge ' + (kind === 'ok' ? 'badge-ok' : kind === 'err' ? 'badge-err' : 'badge-wait');
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
      img.src = url;
      img.alt = filename;
      div.appendChild(img);
    } else if (mime.startsWith('video/')) {
      const v = document.createElement('video');
      v.src = url;
      v.controls = true;
      v.playsInline = true;
      div.appendChild(v);
    } else if (mime.startsWith('audio/')) {
      const a = document.createElement('audio');
      a.src = url;
      a.controls = true;
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

  // ---- WebRTC: RTCPeerConnection oluştur ----
  function createPC() {
    const conn = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] // yalnızca NAT geçişi; veri sunucuya gitmez
    });

    conn.onconnectionstatechange = () => {
      const st = conn.connectionState;
      if (st === 'connected') setStatus('Bağlı • Uçtan uca şifreli', 'ok');
      else if (st === 'failed' || st === 'disconnected') setStatus('Bağlantı koptu', 'err');
    };

    if (ROLE === 'desktop') {
      // Masaüstü tarafı veri kanalını açar
      const channel = conn.createDataChannel('p2p', { ordered: true });
      wireDataChannel(channel);
    } else {
      // Mobil tarafı veri kanalını bekler
      conn.ondatachannel = (ev) => wireDataChannel(ev.channel);
    }

    return conn;
  }

  function wireDataChannel(channel) {
    dc = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      dataChannelReady = true;
      showChat();
      addMessage('🔐 P2P bağlantı kuruldu. Uçtan uca şifreli (DTLS).', 'them');
    };

    channel.onclose = () => {
      dataChannelReady = false;
      setStatus('Bağlantı kapandı', 'err');
    };

    channel.onmessage = (ev) => handleIncoming(ev.data);
  }

  // ---- Gelen veri işleyici ----
  function handleIncoming(data) {
    // Metin mesajı
    if (typeof data === 'string') {
      let payload;
      try { payload = JSON.parse(data); } catch { return; }
      if (payload.t === 'text') {
        addMessage(payload.text, 'them', new Date(payload.ts).toLocaleTimeString('tr-TR'));
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
      // İlk 36 byte = dosya id (UUID string) → geri kalanı içerik
      const view = new Uint8Array(data);
      const idBytes = view.slice(0, 36);
      const id = new TextDecoder().decode(idBytes);
      const content = data.slice(36);

      const f = incomingFiles.get(id);
      if (!f) return;
      f.chunks.push(content);
      f.received += content.byteLength;

      const pct = f.size ? (f.received / f.size) * 100 : 0;
      showProgress(`Alınıyor: ${f.name}`, pct);
    }
  }

  // ---- Metin gönderme ----
  function sendText(text) {
    if (!dataChannelReady) return;
    const payload = JSON.stringify({ t: 'text', text, ts: Date.now() });
    dc.send(payload);
    addMessage(text, 'me', new Date().toLocaleTimeString('tr-TR'));
  }

  // ---- Dosya gönderme (chunked) ----
  async function sendFile(file) {
    if (!dataChannelReady) return;
    const id = crypto.randomUUID();
    const idBytes = new TextEncoder().encode(id); // 36 byte
    if (idBytes.length !== 36) {
      // UUID her zaman 36 karakter; güvence
    }

    // Bildirim
    dc.send(JSON.stringify({
      t: 'file-start',
      id,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream'
    }));

    // Gönderen tarafında da ön izleme (kendi mesajımız)
    const preview = file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/')
      ? addBlobMessage(file, 'me', file.name, file.type)
      : addBlobMessage(file, 'me', file.name, file.type || '');

    showProgress(`Gönderiliyor: ${file.name}`, 0);

    let offset = 0;
    while (offset < file.size) {
      // Buffer doluysa bekle
      if (dc.bufferedAmount > HIGH_WATER) {
        await new Promise((res) => {
          const check = () => {
            if (dc.bufferedAmount <= HIGH_WATER) res();
            else setTimeout(check, 40);
          };
          check();
        });
      }

      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buf = await slice.arrayBuffer();

      // id (36) + içerik
      const combined = new Uint8Array(idBytes.length + buf.byteLength);
      combined.set(idBytes, 0);
      combined.set(new Uint8Array(buf), idBytes.length);

      dc.send(combined.buffer);
      offset += buf.byteLength;

      const pct = (offset / file.size) * 100;
      showProgress(`Gönderiliyor: ${file.name}`, pct);
    }

    dc.send(JSON.stringify({ t: 'file-end', id }));
    hideProgress();
  }

  // ---- Masaüstü: QR üret ----
  async function initDesktop() {
    setStatus('Oturum hazırlanıyor…', 'wait');
    pc = createPC();

    // Teklif (offer) oluştur
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // ICE toplama tamamlanmasını bekle
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const check = () => {
        if (pc.iceGatheringState === 'complete') resolve();
        else setTimeout(check, 100);
      };
      pc.onicegatheringstatechange = check;
      check();
    });

    const payload = JSON.stringify({
      v: 1,
      sdp: pc.localDescription.sdp,
      type: pc.localDescription.type
    });

    // QR göster
    $('peerIdLabel').textContent = payload.slice(0, 10) + '…';
    const qrBox = $('qrcode');
    qrBox.innerHTML = '';
    // eslint-disable-next-line no-undef
    new QRCode(qrBox, {
      text: payload,
      width: 260,
      height: 260,
      correctLevel: QRCode.CorrectLevel.M
    });

    setStatus('QR kod hazır — telefonla okutun', 'wait');

    // Mobil taraftan cevap (answer) alınana kadar bekle:
    // Cevabı almak için URL hash kullanmıyoruz; bunun yerine
    // mobil taraftan gelen cevabı, aynı tarayıcı oturumundaki
    // BroadcastChannel üzerinden alamayız (cihazlar farklı).
    //
    // Çözüm: Mobil taraf, cevabı tekrar QR olarak gösterir;
    // masaüstü tarafı kamerayla okur. Bu, tamamen sunucusuz
    // (SDP takası için bile sunucu gerekmez) bir akıştır.
    //
    // Ancak pratikte çoğu kullanıcı masaüstünde kamera bulundurmaz.
    // Bu nedenle "manuel kod" (paste) alanı ekliyoruz:
    // Mobil taraf cevabı kısa bir kod olarak gösterir, kullanıcı
    // masaüstüne yapıştırır. (SDP küçük tutulur: sadece data channel.)
    attachAnswerReceiver();
  }

  function attachAnswerReceiver() {
    // Cevap kodu için basit bir istem
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:16px;display:flex;flex-direction:column;gap:8px;align-items:center;';
    wrap.innerHTML = `
      <p class="hint" style="margin:0">Mobil cihaz QR'ı okuttuktan sonra ekranda çıkan <b>yanıt kodunu</b> buraya yapıştırın:</p>
      <textarea id="answerInput" placeholder="Yanıt kodunu yapıştırın…"
        style="width:min(92vw,520px);height:90px;padding:10px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-family:monospace;font-size:12px;"></textarea>
      <button id="answerBtn" style="padding:10px 20px;border:none;border-radius:10px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;">Bağlan</button>
    `;
    qrSection.appendChild(wrap);

    $('answerBtn').onclick = async () => {
      const raw = $('answerInput').value.trim();
      if (!raw) return;
      try {
        const answer = JSON.parse(raw);
        await pc.setRemoteDescription(answer);
        setStatus('Cevap alındı, bağlanıyor…', 'wait');
      } catch (e) {
        alert('Yanıt kodu geçersiz: ' + e.message);
      }
    };
  }

  // ---- Mobil: QR tara ----
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
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code && code.data) {
          scanning = false;
          stream.getTracks().forEach((t) => t.stop());
          onQRScanned(code.data);
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setStatus('QR aranıyor…', 'wait');
  }

  async function onQRScanned(raw) {
    let offer;
    try { offer = JSON.parse(raw); } catch { alert('Geçersiz QR'); location.reload(); return; }

    pc = createPC();
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // ICE toplama tamamlanmasını bekle
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const check = () => {
        if (pc.iceGatheringState === 'complete') resolve();
        else setTimeout(check, 100);
      };
      pc.onicegatheringstatechange = check;
      check();
    });

    // Kısa cevap kodunu göster
    const answerPayload = JSON.stringify({
      type: pc.localDescription.type,
      sdp: pc.localDescription.sdp
    });

    showAnswerUI(answerPayload);
    setStatus('Yanıt kodu hazır — masaüstüne yapıştırın', 'wait');
  }

  function showAnswerUI(answerPayload) {
    scanSection.innerHTML = `
      <p class="hint">Aşağıdaki yanıt kodunu <b>bilgisayardaki</b> Web arayüzüne yapıştırın:</p>
      <textarea readonly style="width:92vw;max-width:520px;height:120px;padding:10px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#93c5fd;font-family:monospace;font-size:11px;">${answerPayload.replace(/</g, '&lt;')}</textarea>
      <button id="copyBtn" style="padding:10px 20px;border:none;border-radius:10px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;">📋 Kopyala</button>
      <p class="tiny">Yapıştırdıktan sonra bağlantı otomatik kurulacak.</p>
    `;
    $('copyBtn').onclick = async () => {
      try {
        await navigator.clipboard.writeText(answerPayload);
        $('copyBtn').textContent = '✅ Kopyalandı';
      } catch {
        // Fallback
        const ta = document.querySelector('textarea');
        ta.select();
        document.execCommand('copy');
        $('copyBtn').textContent = '✅ Kopyalandı';
      }
    };
  }

  // ---- Form olayları ----
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
    for (const f of files) {
      await sendFile(f);
    }
    fileInput.value = '';
  });

  // ---- Başlat ----
  if (ROLE === 'desktop') initDesktop();
  else initMobile();

  // ---- Service Worker kaydı ----
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
