'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useOrg } from '@/hooks/use-org';
import {
  IconLayoutDashboard,
  IconRobot,
  IconListCheck,
  IconShieldCheck,
  IconActivity,
  IconChartDots3,
  IconFlask,
  IconBook2,
  IconPuzzle,
  IconSettings,
  IconSearch,
  IconClock,
  IconTarget,
  IconMessages,
  IconNotes,
  IconSitemap,
  IconAddressBook,
  IconEye,
  IconGitCompare,
  IconBomb,
  IconReceipt,
  IconBooks,
  IconUsersGroup,
  IconCalendar,
  IconBrandInstagram,
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  badge?: number;
  section?: string;
}

const navItems: NavItem[] = [
  // Core
  { label: 'Needs you', href: '/approvals', icon: IconShieldCheck, section: 'core' },
  { label: 'Team', href: '/team', icon: IconUsersGroup, section: 'core' },
  { label: 'Calendar', href: '/calendar', icon: IconCalendar, section: 'core' },
  { label: 'Instagram', href: '/instagram', icon: IconBrandInstagram, section: 'core' },
  { label: 'Overview', href: '/', icon: IconLayoutDashboard, section: 'core' },
  { label: 'CRM', href: '/crm', icon: IconAddressBook, section: 'core' },
  { label: 'Projects', href: '/projects', icon: IconSitemap, section: 'core' },
  { label: 'Agents', href: '/agents', icon: IconRobot, section: 'core' },
  { label: 'Tasks', href: '/tasks', icon: IconListCheck, section: 'core' },
  { label: 'Activity', href: '/activity', icon: IconActivity, section: 'core' },

  // Operations
  { label: 'Comms', href: '/comms', icon: IconMessages, section: 'ops' },
  { label: 'Workflows', href: '/workflows', icon: IconClock, section: 'ops' },
  { label: 'Strategy', href: '/strategy', icon: IconTarget, section: 'ops' },
  { label: 'Analytics', href: '/analytics', icon: IconChartDots3, section: 'ops' },

  // Intelligence
  { label: 'Knowledge Base', href: '/knowledge-base', icon: IconBook2, section: 'intel' },
  { label: 'Wiki', href: '/wiki', icon: IconNotes, section: 'intel' },
  { label: 'Experiments', href: '/experiments', icon: IconFlask, section: 'intel' },
  { label: 'Skills', href: '/skills', icon: IconPuzzle, section: 'intel' },

  // Proof (Glitch Cat Club methods)
  { label: 'Fleet truth', href: '/truth', icon: IconEye, section: 'proof' },
  { label: 'Done drift', href: '/drift', icon: IconGitCompare, section: 'proof' },
  { label: 'Landmines', href: '/landmines', icon: IconBomb, section: 'proof' },
  { label: 'Receipts', href: '/receipts', icon: IconReceipt, section: 'proof' },
  { label: 'Kem library', href: '/library', icon: IconBooks, section: 'proof' },
];

const sectionLabels: Record<string, string> = {
  core: '',
  ops: 'Operations',
  intel: 'Intelligence',
  proof: 'Proof',
};

interface SidebarProps {
  pendingApprovals?: number;
  inProgressTasks?: number;
  onNavigate?: () => void;
  onSearchClick?: () => void;
}

export function Sidebar({
  pendingApprovals = 0,
  inProgressTasks = 0,
  onNavigate,
  onSearchClick,
}: SidebarProps) {
  const pathname = usePathname();
  const { currentOrg } = useOrg();

  function orgHref(href: string) {
    if (currentOrg && currentOrg !== 'all') {
      return `${href}${href.includes('?') ? '&' : '?'}org=${encodeURIComponent(currentOrg)}`;
    }
    return href;
  }

  function isActive(href: string) {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  }

  function getBadge(item: NavItem): number {
    if (item.href === '/approvals') return pendingApprovals;
    if (item.href === '/tasks') return inProgressTasks;
    return 0;
  }

  // Group items by section
  const sections = ['core', 'proof', 'ops', 'intel'];

  return (
    <aside className="flex h-screen w-56 shrink-0 flex-col border-r-2 border-primary bg-sidebar text-sidebar-foreground">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2 px-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/ogl-mark.png" alt="One Giant Leap" className="h-7 w-auto" />
        <span data-ogl-title className="text-lg leading-none">OGL Dashboard</span>
      </div>

      {/* Search trigger */}
      <div className="px-3 pb-2">
        <button
          onClick={onSearchClick}
          className="flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent px-3 py-1.5 text-xs text-sidebar-foreground/70 hover:text-sidebar-foreground transition-colors"
        >
          <IconSearch size={14} />
          <span>Search...</span>
          <kbd className="ml-auto rounded border border-sidebar-border bg-sidebar px-1 py-0.5 text-[10px] font-mono">
            /
          </kbd>
        </button>
      </div>

      <Separator className="bg-sidebar-border" />

      {/* Navigation */}
      <nav className="flex flex-1 flex-col overflow-y-auto px-2 py-2">
        {sections.map((section) => {
          const items = navItems.filter((i) => i.section === section);
          const label = sectionLabels[section];

          return (
            <div key={section} className="mb-1">
              {label && (
                <p className="px-3 pb-1 pt-3 font-mono text-[10px] font-medium uppercase tracking-widest text-sidebar-foreground/50">
                  {label}
                </p>
              )}
              {items.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                const badge = getBadge(item);

                return (
                  <Link
                    key={item.href}
                    href={orgHref(item.href)}
                    onClick={onNavigate}
                    className={cn(
                      'group flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] transition-all',
                      active
                        ? 'bg-primary text-primary-foreground font-semibold'
                        : 'text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-foreground'
                    )}
                  >
                    <Icon
                      size={16}
                      className={cn(
                        'shrink-0 transition-colors',
                        active ? 'text-primary-foreground' : 'text-sidebar-foreground/60 group-hover:text-sidebar-foreground'
                      )}
                    />
                    <span className="truncate">{item.label}</span>
                    {badge > 0 && (
                      <Badge
                        variant={active ? 'default' : 'secondary'}
                        className="ml-auto h-4.5 min-w-5 px-1 text-[10px] font-medium"
                      >
                        {badge}
                      </Badge>
                    )}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>

      <Separator className="bg-sidebar-border" />

      {/* Settings at bottom */}
      <div className="px-2 py-2">
        <Link
          href={orgHref('/settings')}
          onClick={onNavigate}
          className={cn(
            'flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] transition-all',
            isActive('/settings')
              ? 'bg-primary text-primary-foreground font-semibold'
              : 'text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-foreground'
          )}
        >
          <IconSettings size={16} className="shrink-0" />
          <span>Settings</span>
        </Link>
      </div>
    </aside>
  );
}
