// Service Worker mínimo do CRM. Único objetivo: tornar o app instalável (PWA)
// e sobreviver a uma queda de conexão breve — não é um cache agressivo.
//
// IMPORTANTE: usa estratégia "network-first" pro app shell (HTML/JS/CSS), não
// "cache-first". Esse sistema é atualizado com frequência (várias vezes por
// dia); um cache-first deixaria os atendentes presos numa versão antiga do
// app.js/index.html até limparem o cache manualmente. Com network-first, a
// rede sempre vence quando está disponível — o cache só entra como fallback
// se a requisição falhar (offline / instável). /api/*, o webhook e o SSE
// (EventSource não passa por "fetch" nem por este arquivo) nunca são
// interceptados: tudo que é dinâmico segue direto pra rede, sempre.
const CACHE_NAME = 'crm-shell-v1';
const APP_SHELL = ['/', '/style.css', '/app.js', '/wa_chat_logic.js', '/flows.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL).catch(() => {}))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    // Nunca mexe em API, webhook ou qualquer coisa fora da própria origem.
    if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

    event.respondWith(
        fetch(req)
            .then((res) => {
                const copy = res.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
                return res;
            })
            .catch(() => caches.match(req).then((cached) => cached || Response.error()))
    );
});

// --- Web Push: notificação nativa (Windows/Android) mesmo com o app fechado ---
self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) {}
    const title = data.title || 'CRM';
    const body = data.body || '';
    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon: '/icon.svg',
            badge: '/icon.svg',
            tag: data.phone || undefined, // mesma origem substitui a notificação anterior, não empilha
            data: { phone: data.phone || null }
        })
    );
});

// Clicar na notificação: foca uma aba já aberta do CRM, ou abre uma nova.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            for (const client of list) {
                if ('focus' in client) return client.focus();
            }
            if (self.clients.openWindow) return self.clients.openWindow('/');
        })
    );
});
