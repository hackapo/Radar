// firebase-messaging-sw.js

// Importe e inicialize o SDK do Firebase.
// Estes dois imports são essenciais para o Service Worker lidar com o FCM.
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

// Substitua "10.x.x" pela versão que você está usando no seu index.html.

// Objeto de configuração do Firebase.
// **IMPORTANTE**: Este objeto precisa ser o MESMO que você usou no seu index.html
// para inicializar o Firebase.
const firebaseConfig = {
  apiKey: "AIzaSyBihZBPsJwoQq4kvaLub8FgtCcw3n17Ab0",
  authDomain: "radar-26442.firebaseapp.com",
  projectId: "radar-26442",
  storageBucket: "radar-26442.firebasestorage.app",
  messagingSenderId: "48487444611",
  appId: "1:48487444611:web:afd1767ee32f0e6cf06bb6",
};

// Inicialize o Firebase dentro do Service Worker
firebase.initializeApp(firebaseConfig);

// Recupere uma instância do Firebase Messaging
const messaging = firebase.messaging();

// Este código lida com as mensagens push que chegam quando o navegador está em segundo plano.
// Ele mostra uma notificação no sistema operacional do usuário.
messaging.onBackgroundMessage(function(payload) {
    console.log('[firebase-messaging-sw.js] Received background message ', payload);

    // Personalize sua notificação aqui
    const notificationTitle = payload.notification.title;
    const notificationOptions = {
        body: payload.notification.body,
        icon: 'https://www.radarfutebol.com/favicon.ico'
        // Outras opções de notificação: badge, image, click_action, etc.
    };

    return self.registration.showNotification(notificationTitle, notificationOptions);
});

// Opcional: Você pode adicionar listeners para eventos de clique na notificação, etc.
self.addEventListener('notificationclick', function(event) {
    event.notification.close();

    // Pega a URL enviada no payload ou define uma padrão
    const urlToOpen = event.notification.data?.url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(windowClients) {
            for (var i = 0; i < windowClients.length; i++) {
                var client = windowClients[i];
                if (client.url === urlToOpen && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(urlToOpen);
            }
        })
    );
});
