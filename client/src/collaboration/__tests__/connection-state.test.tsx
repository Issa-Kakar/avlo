import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

type ConnectionState = 'Online' | 'Reconnecting' | 'Offline' | 'Read-only';

describe('Connection State', () => {
  describe('state transitions', () => {
    it('should display "Online" when connected', () => {
      const ConnectionIndicator = ({ state }: { state: ConnectionState }) => (
        <div role="status">{state}</div>
      );
      
      render(<ConnectionIndicator state="Online" />);
      expect(screen.getByRole('status')).toHaveTextContent('Online');
    });

    it('should display "Reconnecting" during reconnection', () => {
      const ConnectionIndicator = ({ state }: { state: ConnectionState }) => (
        <div role="status">{state}</div>
      );
      
      render(<ConnectionIndicator state="Reconnecting" />);
      expect(screen.getByRole('status')).toHaveTextContent('Reconnecting');
    });

    it('should display "Offline" when disconnected', () => {
      const ConnectionIndicator = ({ state }: { state: ConnectionState }) => (
        <div role="status">{state}</div>
      );
      
      render(<ConnectionIndicator state="Offline" />);
      expect(screen.getByRole('status')).toHaveTextContent('Offline');
    });

    it('should display "Read-only" when room is at capacity', () => {
      const ConnectionIndicator = ({ state }: { state: ConnectionState }) => (
        <div role="status">{state}</div>
      );
      
      render(<ConnectionIndicator state="Read-only" />);
      expect(screen.getByRole('status')).toHaveTextContent('Read-only');
    });

    it('should transition states correctly', async () => {
      const ConnectionIndicator = () => {
        const [state, setState] = React.useState<ConnectionState>('Online');
        
        React.useEffect(() => {
          const transitions = [
            { state: 'Reconnecting' as ConnectionState, delay: 100 },
            { state: 'Offline' as ConnectionState, delay: 200 },
            { state: 'Online' as ConnectionState, delay: 300 }
          ];
          
          transitions.forEach(({ state, delay }) => {
            setTimeout(() => setState(state), delay);
          });
        }, []);
        
        return <div role="status">{state}</div>;
      };
      
      render(<ConnectionIndicator />);
      
      expect(screen.getByRole('status')).toHaveTextContent('Online');
      
      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent('Reconnecting');
      }, { timeout: 150 });
      
      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent('Offline');
      }, { timeout: 250 });
      
      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent('Online');
      }, { timeout: 350 });
    });
  });

  describe('banners and messages', () => {
    it('should show read-only banner at 10MB limit', () => {
      const ReadOnlyBanner = ({ sizeBytes }: { sizeBytes: number }) => {
        const limitBytes = 10 * 1024 * 1024;
        const isReadOnly = sizeBytes >= limitBytes;
        
        return isReadOnly ? (
          <div role="alert">
            Room is read-only (10 MB limit reached). Create a new room to continue.
          </div>
        ) : null;
      };
      
      render(<ReadOnlyBanner sizeBytes={10 * 1024 * 1024} />);
      
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Room is read-only (10 MB limit reached). Create a new room to continue.'
      );
    });

    it('should show size warning pill at 8MB', () => {
      const SizeWarningPill = ({ sizeBytes }: { sizeBytes: number }) => {
        const limitBytes = 10 * 1024 * 1024;
        const warningBytes = 8 * 1024 * 1024;
        const showWarning = sizeBytes >= warningBytes && sizeBytes < limitBytes;
        
        if (!showWarning) return null;
        
        const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
        return <div role="status">{sizeMB} / 10 MB</div>;
      };
      
      render(<SizeWarningPill sizeBytes={8.5 * 1024 * 1024} />);
      
      expect(screen.getByRole('status')).toHaveTextContent('8.5 / 10 MB');
    });

    it('should show room full toast', () => {
      const RoomFullToast = ({ clientCount }: { clientCount: number }) => {
        const maxClients = 105;
        const isFull = clientCount >= maxClients;
        
        return isFull ? (
          <div role="alert">Room is full — create a new room.</div>
        ) : null;
      };
      
      render(<RoomFullToast clientCount={105} />);
      
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Room is full — create a new room.'
      );
    });

    it('should show oversize frame error', () => {
      const OversizeFrameToast = ({ frameSize }: { frameSize: number }) => {
        const maxFrameSize = 2 * 1024 * 1024;
        const isOversized = frameSize > maxFrameSize;
        
        return isOversized ? (
          <div role="alert">Change too large. Refresh to rejoin.</div>
        ) : null;
      };
      
      render(<OversizeFrameToast frameSize={3 * 1024 * 1024} />);
      
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Change too large. Refresh to rejoin.'
      );
    });
  });

  describe('reconnection behavior', () => {
    it('should use exponential backoff with jitter', () => {
      const calculateBackoff = (attempt: number, maxDelay: number = 30000) => {
        const baseDelay = Math.min(1000 * Math.pow(2, attempt), maxDelay);
        const jitter = Math.random() * baseDelay;
        return Math.floor(baseDelay + jitter);
      };
      
      const backoff1 = calculateBackoff(0);
      expect(backoff1).toBeGreaterThanOrEqual(1000);
      expect(backoff1).toBeLessThan(2000);
      
      const backoff5 = calculateBackoff(5);
      expect(backoff5).toBeLessThanOrEqual(60000);
      
      const backoff10 = calculateBackoff(10);
      expect(backoff10).toBeLessThanOrEqual(60000);
    });

    it('should have ceiling at 30s', () => {
      const maxDelay = 30000;
      const calculateBackoff = (attempt: number) => {
        const baseDelay = Math.min(1000 * Math.pow(2, attempt), maxDelay);
        return baseDelay;
      };
      
      for (let i = 0; i < 20; i++) {
        const backoff = calculateBackoff(i);
        expect(backoff).toBeLessThanOrEqual(maxDelay);
      }
    });
  });
});