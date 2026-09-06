/**
 * Les recompenses du parcours : ce qui se voit, ce qui s'entend.
 *
 * Configurer un serveur est un travail administratif, et le parcours ne peut
 * pas faire semblant du contraire. Ce qu'il peut faire, c'est marquer les
 * moments ou quelque chose vient reellement d'aboutir - une phase franchie, un
 * serveur monte, un parcours termine - au lieu de les laisser passer comme un
 * changement d'ecran de plus. C'est peu de chose et c'est exactement ce qui
 * separe « j'ai rempli un formulaire » de « j'ai monte mon serveur ».
 *
 * Trois regles tiennent ce fichier :
 *
 * 1. Rien n'est bloquant. Confettis et sons sont poses par-dessus la page, en
 *    `pointer-events: none`, et disparaissent seuls. Un navigateur qui refuse
 *    l'audio ou un canvas qui ne s'initialise pas ne doivent jamais empecher de
 *    passer a l'ecran suivant.
 * 2. Rien n'est telecharge. Les sons sont synthetises a la volee par WebAudio :
 *    pas de fichier a servir, pas de requete a attendre, pas de kilo-octet
 *    ajoute au chargement pour trois « pop ».
 * 3. Tout s'arrete. `prefers-reduced-motion` coupe les confettis, et le son se
 *    coupe d'un clic - le reglage est retenu par navigateur.
 *
 * Le son est actif par defaut, mais aucun navigateur ne laisse une page emettre
 * avant qu'on ait clique dedans : la premiere celebration reellement audible est
 * donc toujours posterieure a une action volontaire, ce qui est precisement la
 * garantie qu'on voudrait ecrire a la main.
 */

const SOUND_KEY = 'kotbo-wizard-sound';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

// ── Son ──────────────────────────────────────────────────────────────────────

let audioContext: AudioContext | null = null;

function readSoundPreference(): boolean {
  try {
    // Absent = actif : le reglage n'existe que pour l'avoir coupe.
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

let soundOn = readSoundPreference();

export const sound = {
  get enabled() {
    return soundOn;
  },
  toggle(): boolean {
    soundOn = !soundOn;
    try {
      localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off');
    } catch {
      // Mode prive : le reglage vaut pour la session.
    }
    // Un retour immediat, sinon activer le son ne produit rien d'audible et
    // l'on ne sait pas si le bouton a fonctionne.
    if (soundOn) tone([660, 880], 0.09);
    return soundOn;
  },
};

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioContext) {
    try {
      audioContext = new Ctor();
    } catch {
      return null;
    }
  }
  // Suspendu tant que la page n'a pas ete touchee : la reprise echoue en
  // silence si le geste n'a pas eu lieu, et reussit des le premier clic.
  if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
  return audioContext;
}

/**
 * Une petite montee de notes, en sinus.
 *
 * Une onde sinusoidale et une enveloppe qui retombe vite : c'est ce qui
 * ressemble le moins a une alarme. Les notes s'enchainent sur un accord plutot
 * que sur une gamme - deux frequences dissonantes suffisent a rendre un
 * « bravo » desagreable.
 */
function tone(frequencies: number[], step = 0.11, volume = 0.055): void {
  if (!soundOn) return;
  const ctx = context();
  if (!ctx) return;

  frequencies.forEach((frequency, index) => {
    const startAt = ctx.currentTime + index * step;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, startAt);

    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(volume, startAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + step + 0.16);

    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + step + 0.2);
  });
}

// ── Confettis ────────────────────────────────────────────────────────────────

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  spin: number;
  angle: number;
  color: string;
};

/**
 * La palette des confettis.
 *
 * Ecrite en dur plutot que prise dans les jetons du theme : le vert et le violet
 * d'une confetti n'ont pas a suivre la couleur d'accent choisie par le serveur,
 * et un jeton de theme sombre donnerait une pluie de particules invisibles sur
 * fond sombre.
 */
const COLORS = ['#00E5FF', '#5865F2', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6'];

/**
 * Une pluie de confettis, par-dessus la page.
 *
 * Le canvas est cree pour l'occasion et retire quand la derniere particule est
 * sortie du cadre : rien ne reste attache au document entre deux celebrations,
 * et une page laissee ouverte ne garde pas une boucle d'animation en vie.
 */
export function confetti(options: { count?: number; originY?: number; spread?: number } = {}): void {
  if (typeof document === 'undefined' || prefersReducedMotion()) return;

  const { count = 90, originY = 0.42, spread = 1 } = options;

  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  ctx.scale(ratio, ratio);
  document.body.appendChild(canvas);

  const particles: Particle[] = Array.from({ length: count }, () => {
    const angle = (-Math.PI / 2) + (Math.random() - 0.5) * 1.5 * spread;
    const speed = 7 + Math.random() * 9;
    return {
      x: width / 2 + (Math.random() - 0.5) * width * 0.35 * spread,
      y: height * originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 5 + Math.random() * 6,
      spin: (Math.random() - 0.5) * 0.28,
      angle: Math.random() * Math.PI,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    };
  });

  let frame = 0;
  const started = performance.now();

  function draw(now: number) {
    ctx!.clearRect(0, 0, width, height);
    let alive = 0;

    for (const particle of particles) {
      particle.vy += 0.32;      // gravite
      particle.vx *= 0.992;     // frottement horizontal
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.angle += particle.spin;

      if (particle.y > height + 40) continue;
      alive += 1;

      // Les 400 dernieres millisecondes s'effacent : sans cela, les confettis
      // qui sortent par les cotes disparaissent d'un coup, en plein cadre.
      const remaining = Math.max(0, 1 - (now - started - 2200) / 400);
      ctx!.save();
      ctx!.globalAlpha = Math.min(1, remaining);
      ctx!.translate(particle.x, particle.y);
      ctx!.rotate(particle.angle);
      ctx!.fillStyle = particle.color;
      ctx!.fillRect(-particle.size / 2, -particle.size / 3, particle.size, particle.size * 0.62);
      ctx!.restore();
    }

    if (alive > 0 && now - started < 2600) {
      frame = requestAnimationFrame(draw);
    } else {
      cancelAnimationFrame(frame);
      canvas.remove();
    }
  }

  frame = requestAnimationFrame(draw);
}

// ── Les trois moments ────────────────────────────────────────────────────────

/** Une etape validee : une note, rien de plus. C'est un accuse de reception. */
export function celebrateStep(): void {
  tone([784], 0.07, 0.035);
}

/**
 * Une phase franchie. Trois notes montantes et une poignee de confettis.
 *
 * C'est le moment ou le parcours dit « vous avez fini quelque chose », et il
 * n'arrive que quatre ou cinq fois : le rendre plus discret le ferait passer
 * inapercu, le rendre plus long le ferait attendre.
 */
export function celebratePhase(): void {
  tone([523.25, 659.25, 783.99]);
  confetti({ count: 46, originY: 0.3, spread: 0.7 });
}

/** Le serveur monte, ou le parcours termine. La seule grande celebration. */
export function celebrateFinale(): void {
  tone([523.25, 659.25, 783.99, 1046.5], 0.13, 0.07);
  confetti({ count: 140, originY: 0.5, spread: 1.4 });
  // Une seconde salve, decalee : une seule pluie retombe trop vite pour un
  // ecran ou l'on s'attarde.
  setTimeout(() => confetti({ count: 90, originY: 0.35, spread: 1.8 }), 420);
}
