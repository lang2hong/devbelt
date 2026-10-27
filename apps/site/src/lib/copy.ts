export const VERSION = 'v0.4.0';

export const URLS = {
  ext: 'https://marketplace.visualstudio.com/items?itemName=lang2hong.devbelt-db-client',
  ovsx: 'https://open-vsx.org/extension/lang2hong/devbelt-db-client',
  github: 'https://github.com/lang2hong/devbelt',
  changelog: 'https://github.com/lang2hong/devbelt/blob/main/CHANGELOG.md',
  releases: 'https://github.com/lang2hong/devbelt/releases/tag/v0.4.0',
  docs: '/db/docs',
  plans: '/plans',
  login: '/login',
  register: '/register',
  console: '/db/',
} as const;

export const INSTALL_CMD = 'code --install-extension lang2hong.devbelt-db-client';

export interface Feature {
  icon: string;
  title: string;
  desc: string;
}

export interface Showcase {
  title: string;
  paras: string[];
  bullets: string[];
  img: string;
  alt: string;
  /** 原图像素宽高，用于预留版面避免布局跳动。 */
  w: number;
  h: number;
  reverse?: boolean;
}

export interface NewItem {
  h: string;
  t: string;
}

export interface Copy {
  htmlLang: string;
  meta: { title: string; description: string };
  nav: {
    install: string;
    docs: string;
    github: string;
    features: string;
    plans: string;
    login: string;
    console: string;
    langSwitch: string;
  };
  hero: {
    eyebrowLabel: string;
    eyebrowDesc: string;
    h1Html: string;
    lead: string;
    primary: string;
    primaryConsole: string;
    secondary: string;
    login: string;
    register: string;
    alt: string;
    caption: string;
  };
  features: {
    title: string;
    sub: string;
    items: Feature[];
  };
  showcase: {
    title: string;
    sub: string;
    items: Showcase[];
  };
  news: {
    badge: string;
    title: string;
    items: NewItem[];
    changelog: string;
    colon: string;
  };
  install: {
    title: string;
    sub: string;
    vsc: { tag: string; tagRec: string; title: string; desc: string; btn: string };
    ovsx: { tag: string; title: string; sub: string; desc: string; btn: string };
    vsix: { title: string; desc: string; size: string; btn: string };
  };
  footer: {
    tagline: string;
    productHead: string;
    product: { features: string; docs: string; plans: string };
    resourcesHead: string;
    resources: { docs: string; changelog: string; github: string };
    getHead: string;
    get: { vsc: string; ovsx: string };
    ver: (v: string) => string;
    license: string;
    rights: string;
  };
}
