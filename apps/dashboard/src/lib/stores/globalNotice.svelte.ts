/**
 * Message bloquant a annoncer depuis une page qu'on quitte au meme instant.
 *
 * Une redirection perd tout etat local : le message d'erreur qui justifiait
 * le depart doit donc survivre ailleurs le temps d'etre lu. Une seule bulle
 * suffit - un nouvel appel remplace la precedente plutot que d'empiler.
 */
class GlobalNoticeStore {
  open = $state(false);
  message = $state('');

  show(message: string) {
    this.message = message;
    this.open = true;
  }

  close() {
    this.open = false;
  }
}

export const globalNotice = new GlobalNoticeStore();
