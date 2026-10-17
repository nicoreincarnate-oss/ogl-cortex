import type { MetadataRoute } from 'next';

// Installs Cortex OS as a home-screen app; opens on Needs you. ?v= forces phones to refetch the icon.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Cortex OS',
    short_name: 'Cortex OS',
    description: 'One Giant Leap: the team, your day and the proof',
    start_url: '/approvals',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: '#0a0a0a',
    icons: [
      { src: '/ogl-icon-192.png?v=2', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/ogl-icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/ogl-icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
