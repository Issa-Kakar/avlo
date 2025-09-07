import React, { useEffect, useState } from 'react';

interface ToastProps {
  message: string;
  show: boolean;
  onClose: () => void;
  duration?: number;
}

export function Toast({ message, show, onClose, duration = 2000 }: ToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (show) {
      setVisible(true);
      const timer = setTimeout(() => {
        setVisible(false);
        setTimeout(onClose, 200); // Wait for animation to complete
      }, duration);

      return () => clearTimeout(timer);
    } else {
      setVisible(false);
    }
  }, [show, duration, onClose]);

  if (!show && !visible) return null;

  return <div className={`toast ${visible ? 'show' : ''}`}>{message}</div>;
}

interface ToastManagerProps {
  children: React.ReactNode;
}

interface ToastState {
  message: string;
  show: boolean;
}

export const ToastContext = React.createContext<{
  showToast: (message: string) => void;
}>({
  showToast: () => {},
});

export function ToastProvider({ children }: ToastManagerProps) {
  const [toast, setToast] = useState<ToastState>({ message: '', show: false });

  const showToast = (message: string) => {
    setToast({ message, show: true });
  };

  const hideToast = () => {
    setToast((prev) => ({ ...prev, show: false }));
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <Toast message={toast.message} show={toast.show} onClose={hideToast} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
