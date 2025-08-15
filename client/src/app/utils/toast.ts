let activeToast: HTMLDivElement | null = null;
let toastTimeout: ReturnType<typeof setTimeout> | null = null;

export const toast = {
  show(message: string, duration = 1200) {
    if (activeToast) {
      activeToast.remove();
      if (toastTimeout) clearTimeout(toastTimeout);
    }

    activeToast = document.createElement('div');
    activeToast.className = 'toast';
    activeToast.setAttribute('role', 'status');
    activeToast.setAttribute('aria-live', 'polite');
    activeToast.textContent = message;

    Object.assign(activeToast.style, {
      position: 'fixed',
      bottom: 'var(--space-4)',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '12px 20px',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      boxShadow: 'var(--shadow-lg)',
      color: 'var(--ink)',
      fontWeight: '600',
      fontSize: '14px',
      zIndex: '1000',
      transition: 'all var(--base) var(--ease-out)',
    });

    document.body.appendChild(activeToast);

    requestAnimationFrame(() => {
      if (activeToast) {
        activeToast.classList.add('show');
      }
    });

    toastTimeout = setTimeout(() => {
      if (activeToast) {
        activeToast.classList.remove('show');
        setTimeout(() => {
          if (activeToast) {
            activeToast.remove();
            activeToast = null;
          }
        }, 200);
      }
    }, duration);
  },

  success(message: string) {
    this.show(message);
  },

  error(message: string) {
    this.show(message, 2000);
  },

  info(message: string) {
    this.show(message, 1500);
  },
};
