# UI/UX Update Plan - solpump

## 1. Visual Refresh
- [ ] Modern color system with CSS custom properties (light/dark mode ready)
- [ ] Updated typography scale with fluid sizing
- [ ] Refined spacing system (4px base unit)
- [ ] Improved shadows, borders, and elevation
- [ ] Consistent border radius scale
- [ ] Updated green accent to be more accessible

## 2. Component Improvements
- [ ] Button system: primary, secondary, ghost, danger, outline variants
- [ ] Form controls: inputs, selects, textareas, checkboxes, radios
- [ ] Card system: elevated, outlined, filled variants
- [ ] Modal/Dialog system with focus trap
- [ ] Toast/notification system with animations
- [ ] Dropdown/select components
- [ ] Tooltip system
- [ ] Badge/chip components
- [ ] Progress indicators
- [ ] Table component with sorting
- [ ] Tabs component
- [ ] Avatar component with fallbacks

## 3. Layout Changes
- [ ] Responsive sidebar: collapsible rail → expanded on hover (desktop), drawer (mobile)
- [ ] Sticky header with backdrop blur
- [ ] Improved grid system (auto-fit, minmax)
- [ ] Better container max-widths
- [ ] Consistent page padding/margins
- [ ] Footer improvements

## 4. New Features/Pages
- [ ] Dark mode toggle (persisted in localStorage)
- [ ] Onboarding flow for new users
- [ ] Empty states with illustrations
- [ ] Loading skeletons
- [ ] Command palette (Cmd+K)
- [ ] Keyboard shortcuts help modal
- [ ] Settings page
- [ ] Improved error boundaries

## 5. Accessibility Improvements
- [ ] Semantic HTML structure
- [ ] ARIA labels and roles
- [ ] Focus management (visible focus styles, focus trap in modals)
- [ ] Keyboard navigation for all interactive elements
- [ ] Color contrast ratios (WCAG AA)
- [ ] Reduced motion support
- [ ] Screen reader announcements for dynamic content
- [ ] Skip to main content link

## 6. Mobile/UX Polish
- [ ] Touch-friendly targets (min 44x44px)
- [ ] Swipe gestures for sidebar
- [ ] Pull-to-refresh on feed
- [ ] Better mobile navigation
- [ ] Improved form UX on mobile
- [ ] Haptic feedback simulation (visual)
- [ ] Smooth animations (respecting prefers-reduced-motion)
- [ ] Performance optimizations

---

## Implementation Order

1. **Core Design System** (colors, spacing, typography, shadows)
2. **Base Components** (buttons, inputs, cards, badges)
3. **Layout Components** (sidebar, header, containers)
4. **Page-Level Updates** (feed, create, detail, portfolio, profile)
5. **New Features** (dark mode, onboarding, settings)
6. **Accessibility Audit & Fixes**
7. **Mobile Polish & Testing**

---

## File Changes

### New Files
- `public/design-tokens.css` - Design system tokens
- `public/components/` - Reusable component styles
- `public/app-v2.js` - Updated app with new components (or incremental updates)

### Modified Files
- `public/index.html` - Updated structure, meta tags, accessibility
- `public/styles.css` - Complete redesign using design tokens
- `public/app.js` - Component updates, new features, a11y fixes

---

## Design Token System

```css
:root {
  /* Colors - Light Mode (default) */
  --color-bg-primary: #f5f5f7;
  --color-bg-secondary: #ffffff;
  --color-bg-tertiary: #f0f1ed;
  --color-bg-elevated: #ffffff;
  
  --color-border-subtle: #e2e4df;
  --color-border-default: #cfd3cc;
  --color-border-strong: #a8b0a6;
  
  --color-text-primary: #0c1500;
  --color-text-secondary: #263020;
  --color-text-tertiary: #687365;
  --color-text-inverse: #ffffff;
  --color-text-disabled: #9ca39d;
  
  --color-brand-primary: #00c805;
  --color-brand-primary-hover: #00b004;
  --color-brand-primary-active: #009603;
  --color-brand-on-primary: #0c1500;
  --color-brand-subtle: #e4f8e4;
  --color-brand-border: #1a5821;
  
  --color-success: #18883b;
  --color-success-subtle: #dcfce7;
  --color-danger: #d94332;
  --color-danger-subtle: #fee2e2;
  --color-warning: #b57d00;
  --color-warning-subtle: #fef3c7;
  --color-info: #3974bf;
  --color-info-subtle: #dbeafe;
  
  /* Spacing (4px base) */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;
  
  /* Typography */
  --font-sans: "Geist", ui-rounded, "SF Pro Rounded", system-ui, -apple-system, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  
  --text-xs: 0.75rem;    /* 12px */
  --text-sm: 0.875rem;   /* 14px */
  --text-base: 1rem;     /* 16px */
  --text-lg: 1.125rem;   /* 18px */
  --text-xl: 1.25rem;    /* 20px */
  --text-2xl: 1.5rem;    /* 24px */
  --text-3xl: 1.875rem;  /* 30px */
  --text-4xl: 2.25rem;   /* 36px */
  
  --font-normal: 400;
  --font-medium: 500;
  --font-semibold: 600;
  --font-bold: 700;
  
  --leading-tight: 1.25;
  --leading-normal: 1.5;
  --leading-relaxed: 1.625;
  
  /* Border Radius */
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 24px;
  --radius-full: 9999px;
  
  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(12, 21, 0, 0.04);
  --shadow-md: 0 4px 12px rgba(12, 21, 0, 0.08);
  --shadow-lg: 0 8px 24px rgba(12, 21, 0, 0.1);
  --shadow-xl: 0 16px 48px rgba(12, 21, 0, 0.12);
  
  /* Transitions */
  --transition-fast: 120ms ease;
  --transition-normal: 200ms ease;
  --transition-slow: 300ms ease;
  
  /* Z-index */
  --z-dropdown: 100;
  --z-sticky: 200;
  --z-modal: 300;
  --z-toast: 400;
  --z-tooltip: 500;
  
  /* Layout */
  --sidebar-width-collapsed: 60px;
  --sidebar-width-expanded: 190px;
  --header-height: 56px;
  --infobar-height: 32px;
  --container-max: 1280px;
  --container-wide: 1540px;
}

/* Dark Mode */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-bg-primary: #111113;
    --color-bg-secondary: #18191b;
    --color-bg-tertiary: #1f2123;
    --color-bg-elevated: #1e1f21;
    
    --color-border-subtle: #2a2d2f;
    --color-border-default: #3a3d3f;
    --color-border-strong: #4a4d4f;
    
    --color-text-primary: #f5f5f7;
    --color-text-secondary: #d4d4d8;
    --color-text-tertiary: #a1a1aa;
    --color-text-inverse: #111113;
    --color-text-disabled: #71717a;
    
    --color-brand-primary: #86efac;
    --color-brand-primary-hover: #a3f5c8;
    --color-brand-primary-active: #6ce593;
    --color-brand-on-primary: #052e16;
    --color-brand-subtle: #0c2a14;
    --color-brand-border: #1a5821;
    
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
    --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
    --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
    --shadow-xl: 0 16px 48px rgba(0, 0, 0, 0.6);
  }
}

/* Explicit theme override */
[data-theme="light"] { /* light mode tokens */ }
[data-theme="dark"] { /* dark mode tokens */ }
```

---

## Component API Examples

### Button
```html
<button class="btn btn-primary">Primary</button>
<button class="btn btn-secondary">Secondary</button>
<button class="btn btn-ghost">Ghost</button>
<button class="btn btn-danger">Danger</button>
<button class="btn btn-outline">Outline</button>
<button class="btn btn-sm">Small</button>
<button class="btn btn-lg">Large</button>
<button class="btn" disabled>Disabled</button>
```

### Card
```html
<div class="card card-elevated">Elevated</div>
<div class="card card-outlined">Outlined</div>
<div class="card card-filled">Filled</div>
```

### Input
```html
<div class="form-field">
  <label class="form-label" for="email">Email</label>
  <input class="form-input" id="email" type="email" placeholder="you@example.com">
  <span class="form-hint">We'll never share your email</span>
  <span class="form-error">Invalid email</span>
</div>
```

### Modal
```html
<div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-title">
  <div class="modal">
    <button class="modal-close" aria-label="Close">✕</button>
    <h2 id="modal-title">Title</h2>
    <div class="modal-body">Content</div>
    <div class="modal-footer">
      <button class="btn btn-ghost">Cancel</button>
      <button class="btn btn-primary">Confirm</button>
    </div>
  </div>
</div>
```

---

## Accessibility Checklist

- [ ] All interactive elements have visible focus styles
- [ ] Focus order matches visual order
- [ ] Modals trap focus
- [ ] ARIA labels on icon-only buttons
- [ ] Live regions for dynamic updates (toasts, loading)
- [ ] Color contrast ≥ 4.5:1 for text
- [ ] Color not sole indicator of state
- [ ] Reduced motion respected
- [ ] Skip to main content link
- [ ] Semantic heading hierarchy
- [ ] Form labels associated with inputs
- [ ] Error messages announced
- [ ] Images have alt text