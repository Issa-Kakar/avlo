import { ulid } from 'ulid';
import { generateUserProfile, type UserProfile } from './user-identity';

export interface UserIdentity extends UserProfile {
  userId: string;
}

const STORAGE_KEY = 'avlo:user:v1';

class UserProfileManager {
  private static instance: UserProfileManager;
  private identity: UserIdentity | null = null;
  private listeners = new Set<(identity: UserIdentity) => void>();
  private storageAvailable: boolean = false;

  private constructor() {
    // Test localStorage availability on construction
    this.storageAvailable = this.checkStorageAvailable();
  }

  private checkStorageAvailable(): boolean {
    try {
      const test = '__storage_test__';
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch {
      // localStorage unavailable (private browsing, disabled, etc.)
      return false;
    }
  }

  static getInstance(): UserProfileManager {
    if (!UserProfileManager.instance) {
      UserProfileManager.instance = new UserProfileManager();
    }
    return UserProfileManager.instance;
  }

  /**
   * Get or create stable user identity
   * CRITICAL: Synchronous for use in constructors
   * Handles private browsing and localStorage errors gracefully
   */
  getIdentity(): UserIdentity {
    // Return cached if available
    if (this.identity) {
      return this.identity;
    }

    // Try loading from localStorage (with error handling)
    if (this.storageAvailable) {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          // Validate structure
          if (parsed.userId && parsed.name && parsed.color) {
            this.identity = {
              userId: parsed.userId,
              name: parsed.name,
              color: parsed.color
            };
            return this.identity;
          }
        }
      } catch (err) {
        console.warn('[UserProfileManager] Failed to read from localStorage:', err);
        // Continue to create new identity
      }
    }

    // Create new identity using existing user-identity.ts logic
    const profile = generateUserProfile();
    this.identity = {
      userId: ulid(), // Plain ULID, no prefix
      name: profile.name,
      color: profile.color
    };

    // Try to persist (but don't fail if we can't)
    if (this.storageAvailable) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.identity));
      } catch (err) {
        console.warn('[UserProfileManager] Failed to persist to localStorage:', err);
        // Identity works in memory even if we can't persist
      }
    }

    return this.identity;
  }

  /**
   * Update profile (name/color only, NOT userId)
   */
  updateProfile(updates: Partial<Pick<UserIdentity, 'name' | 'color'>>): void {
    const current = this.getIdentity();
    this.identity = { ...current, ...updates };

    // Try to persist (but don't fail if we can't)
    if (this.storageAvailable) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.identity));
      } catch (err) {
        console.warn('[UserProfileManager] Failed to update localStorage:', err);
      }
    }

    this.notifyListeners();
  }

  /**
   * Subscribe to profile changes
   */
  subscribe(listener: (identity: UserIdentity) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    if (!this.identity) return;
    this.listeners.forEach(listener => listener(this.identity!));
  }

  /**
   * Clear identity (mainly for testing)
   */
  clearIdentity(): void {
    this.identity = null;

    if (this.storageAvailable) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Ignore errors when clearing
      }
    }
  }
}

// Export singleton instance
export const userProfileManager = UserProfileManager.getInstance();