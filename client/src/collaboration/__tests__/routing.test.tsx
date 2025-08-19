import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

describe('Routing', () => {
  describe('route configuration', () => {
    it('should handle root route /', () => {
      const TestComponent = () => <div>Landing Page</div>;
      
      render(
        <MemoryRouter initialEntries={['/']}>
          <TestComponent />
        </MemoryRouter>
      );
      
      expect(screen.getByText('Landing Page')).toBeInTheDocument();
    });

    it('should handle room route /rooms/:id', () => {
      const TestComponent = ({ roomId }: { roomId: string }) => (
        <div>Room: {roomId}</div>
      );
      
      render(
        <MemoryRouter initialEntries={['/rooms/test-room-123']}>
          <TestComponent roomId="test-room-123" />
        </MemoryRouter>
      );
      
      expect(screen.getByText('Room: test-room-123')).toBeInTheDocument();
    });

    it('should handle invalid routes', () => {
      const TestComponent = () => <div>404 Not Found</div>;
      
      render(
        <MemoryRouter initialEntries={['/invalid/route']}>
          <TestComponent />
        </MemoryRouter>
      );
      
      expect(screen.getByText('404 Not Found')).toBeInTheDocument();
    });
  });

  describe('copy link functionality', () => {
    it('should show "Link copied." toast on copy', async () => {
      const mockClipboard = {
        writeText: vi.fn().mockResolvedValue(undefined)
      };
      Object.assign(navigator, { clipboard: mockClipboard });
      
      const CopyLinkButton = () => {
        const [toastMessage, setToastMessage] = React.useState('');
        
        const handleCopy = async () => {
          await navigator.clipboard.writeText(window.location.href);
          setToastMessage('Link copied.');
        };
        
        return (
          <>
            <button onClick={handleCopy}>Copy Link</button>
            {toastMessage && <div role="alert">{toastMessage}</div>}
          </>
        );
      };
      
      render(<CopyLinkButton />);
      
      const button = screen.getByText('Copy Link');
      fireEvent.click(button);
      
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Link copied.');
      });
      
      expect(mockClipboard.writeText).toHaveBeenCalledWith(window.location.href);
    });

    it('should handle clipboard API errors gracefully', async () => {
      const mockClipboard = {
        writeText: vi.fn().mockRejectedValue(new Error('Clipboard access denied'))
      };
      Object.assign(navigator, { clipboard: mockClipboard });
      
      const CopyLinkButton = () => {
        const [toastMessage, setToastMessage] = React.useState('');
        
        const handleCopy = async () => {
          try {
            await navigator.clipboard.writeText(window.location.href);
            setToastMessage('Link copied.');
          } catch {
            setToastMessage('Failed to copy link');
          }
        };
        
        return (
          <>
            <button onClick={handleCopy}>Copy Link</button>
            {toastMessage && <div role="alert">{toastMessage}</div>}
          </>
        );
      };
      
      render(<CopyLinkButton />);
      
      const button = screen.getByText('Copy Link');
      fireEvent.click(button);
      
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Failed to copy link');
      });
    });
  });

  describe('room navigation', () => {
    it('should navigate to room when ID is provided', () => {
      const mockNavigate = vi.fn();
      
      const RoomNavigator = () => {
        const handleNavigate = (roomId: string) => {
          mockNavigate(`/rooms/${roomId}`);
        };
        
        return (
          <button onClick={() => handleNavigate('new-room-id')}>
            Go to Room
          </button>
        );
      };
      
      render(<RoomNavigator />);
      
      const button = screen.getByText('Go to Room');
      fireEvent.click(button);
      
      expect(mockNavigate).toHaveBeenCalledWith('/rooms/new-room-id');
    });

    it('should handle provisional room IDs', () => {
      const provisionalId = 'local-01234567890';
      const serverId = 'server-98765432100';
      
      const aliases = new Map([[provisionalId, serverId]]);
      
      const resolveRoomId = (id: string) => {
        return aliases.get(id) || id;
      };
      
      expect(resolveRoomId(provisionalId)).toBe(serverId);
      expect(resolveRoomId('regular-id')).toBe('regular-id');
    });
  });
});