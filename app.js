// app.js - Ortak WebRTC ve transfer mantığı
const CHUNK_SIZE = 16 * 1024; // 16 KB (WebRTC DataChannel için güvenli)

let pc, dataChannel;
let isOfferer = false;
let receiveBuffer = [];
let receiveSize = 0;
let expectedFileSize = 0;
let currentFileName = '';
let currentFileType = '';

// ---- Yardımcı: QR Kod Gösterme (index.html için) ----
function showQRCode(text) {
  const container = document.getElementById('qr-container');
  if (!container) return;
  container.innerHTML = '';
  // Basit bir QR kütüphanesi CDN üzerinden yüklenmiş olmalı
  if (typeof QRCode !== 'undefined') {
    new QRCode(container, {
      text: text,
      width: 256,
      height: 256
    });
  } else {
    container.textContent = 'QR kütüphanesi yüklenemedi: ' + text;
  }
}

// ---- WebRTC Başlatma ----
async function createPeerConnection() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  pc.ondatachannel = (event) => {
    dataChannel = event.channel;
    setupDataChannel();
  };

  pc.oniceconnectionstatechange = () => {
    console.log('ICE state:', pc.iceConnectionState);
  };

  return pc;
}

function setupDataChannel() {
  dataChannel.binaryType = 'arraybuffer';

  dataChannel.onopen = () => {
    console.log('DataChannel açıldı');
    document.getElementById('connection-status').textContent = 'Bağlandı ✓';
    document.getElementById('chat-area').style.display = 'block';
    document.getElementById('qr-container').style.display = 'none';
    document.getElementById('scanner-container').style.display = 'none';
  };

  dataChannel.onmessage = (event) => {
    const data = event.data;

    // Metin mesajı mı?
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'text') {
          appendMessage(msg.content, 'received');
          return;
        }
        if (msg.type === 'file-meta') {
          currentFileName = msg.name;
          currentFileType = msg.fileType;
          expectedFileSize = msg.size;
          receiveBuffer = [];
          receiveSize = 0;
          return;
        }
        if (msg.type === 'file-end') {
          const blob = new Blob(receiveBuffer, { type: currentFileType });
          const url = URL.createObjectURL(blob);
          appendFilePreview(url, currentFileName, currentFileType, blob);
          receiveBuffer = [];
          receiveSize = 0;
          document.getElementById('receive-progress').value = 0;
          return;
        }
      } catch (e) {
        // JSON değilse düz metin olarak işle
        appendMessage(data, 'received');
      }
    } else {
      // ArrayBuffer = dosya parçası
      receiveBuffer.push(data);
      receiveSize += data.byteLength;
      const progress = document.getElementById('receive-progress');
      if (progress) {
        progress.max = expectedFileSize;
        progress.value = receiveSize;
      }
    }
  };

  dataChannel.onerror = (err) => console.error('DataChannel hatası:', err);
}

// ---- Metin Gönderme ----
function sendText(text) {
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify({ type: 'text', content: text }));
    appendMessage(text, 'sent');
  }
}

// ---- Dosya Gönderme (Parçalama) ----
function sendFile(file) {
  if (!dataChannel || dataChannel.readyState !== 'open') {
    alert('Bağlantı yok!');
    return;
  }

  dataChannel.send(JSON.stringify({
    type: 'file-meta',
    name: file.name,
    fileType: file.type,
    size: file.size
  }));

  const reader = new FileReader();
  let offset = 0;

  reader.onload = (e) => {
    const chunk = e.target.result;
    dataChannel.send(chunk);
    offset += chunk.byteLength;

    const progress = document.getElementById('send-progress');
    if (progress) {
      progress.max = file.size;
      progress.value = offset;
    }

    if (offset < file.size) {
      readSlice(offset);
    } else {
      dataChannel.send(JSON.stringify({ type: 'file-end' }));
    }
  };

  function readSlice(start) {
    const slice = file.slice(start, start + CHUNK_SIZE);
    reader.readAsArrayBuffer(slice);
  }

  readSlice(0);
}

// ---- Mesaj / Dosya Önizleme Ekleme ----
function appendMessage(text, direction) {
  const area = document.getElementById('messages');
  if (!area) return;
  const div = document.createElement('div');
  div.className = 'msg ' + direction;
  div.textContent = text;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

function appendFilePreview(url, name, type, blob) {
  const area = document.getElementById('messages');
  if (!area) return;
  const div = document.createElement('div');
  div.className = 'msg received';

  if (type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = url;
    img.style.maxWidth = '200px';
    div.appendChild(img);
  } else if (type.startsWith('video/')) {
    const vid = document.createElement('video');
    vid.src = url;
    vid.controls = true;
    vid.style.maxWidth = '200px';
    div.appendChild(vid);
  }

  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.textContent = 'İndir: ' + name;
  div.appendChild(document.createElement('br'));
  div.appendChild(link);

  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

// ---- Dışa Aktarılan Fonksiyonlar ----
window.createPeerConnection = createPeerConnection;
window.setupDataChannel = setupDataChannel;
window.sendText = sendText;
window.sendFile = sendFile;
window.showQRCode = showQRCode;
window.appendMessage = appendMessage;