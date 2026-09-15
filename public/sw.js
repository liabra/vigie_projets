// Service worker de Vigie. Une seule responsabilité pour l'instant :
// recevoir les notifications push et les afficher. Pas de cache hors-ligne
// ici — le mode hors-ligne de l'app passe déjà par localStorage.
//
// Vite copie public/ à la racine de dist/, donc ce fichier est servi à
// /sw.js : son scope couvre toute l'app.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Le serveur envoie du JSON { title, body, url }. Si le payload n'est pas
// du JSON (push nu depuis un outil de test), on affiche le texte brut.
self.addEventListener("push", (event) => {
  let data = { title: "Vigie", body: "" };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    data.body = event.data ? event.data.text() : "";
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Vigie", {
      body: data.body || "",
      data: { url: data.url || "/" },
      tag: data.tag || undefined, // un même tag remplace la précédente
    })
  );
});

// Un clic ramène sur l'app : on réutilise un onglet ouvert s'il y en a un.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((tabs) => {
      const open = tabs.find((t) => t.url.startsWith(self.location.origin));
      return open ? open.focus().then((t) => (t.navigate ? t.navigate(url) : t)) : self.clients.openWindow(url);
    })
  );
});
