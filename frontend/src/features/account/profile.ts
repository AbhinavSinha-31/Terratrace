import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../state/auth';

/** A row of public.profiles (supabase/migrations/20261025120000_profiles.sql). RLS: the owner only. */
export interface Profile {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export function useProfile() {
  const userId = useAuth((s) => s.session?.user.id ?? null);
  return useQuery({
    queryKey: ['profile', userId],
    queryFn: userId && supabase
      ? async () => {
        const { data, error } = await supabase!.from('profiles').select('*').eq('id', userId).maybeSingle();
        if (error) throw error;
        return data as Profile | null;
      }
      : skipToken,
    staleTime: 60_000,
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  const userId = useAuth((s) => s.session?.user.id ?? null);
  return useMutation({
    mutationFn: async (patch: Partial<Pick<Profile, 'display_name' | 'avatar_url'>>) => {
      if (!supabase || !userId) throw new Error('Not signed in.');
      const { data, error } = await supabase.from('profiles').update(patch).eq('id', userId).select().single();
      if (error) throw error;
      return data as Profile;
    },
    onSuccess: (p) => qc.setQueryData(['profile', p.id], p),
  });
}

/** Name and photo to show for a user: the profile first, then what Google sent, then the email address. */
export function identity(user: User, profile: Profile | null | undefined) {
  const meta = user.user_metadata ?? {};
  const name: string = profile?.display_name || meta.full_name || meta.name || user.email || 'Signed in';
  const avatar: string | null = profile?.avatar_url || (typeof meta.avatar_url === 'string' && meta.avatar_url.startsWith('https://') ? meta.avatar_url : null);
  return { name, avatar, email: user.email ?? null };
}

/** The signed-in user as shown in the UI (id, name, photo), or null. */
export function useMe() {
  const user = useAuth((s) => s.session?.user ?? null);
  const { data: profile } = useProfile();
  return user ? { id: user.id, ...identity(user, profile) } : null;
}

// ------------------------------------------------------------------------------------------- avatar upload
/** Storage bucket (supabase/migrations/20261120090000_avatars_storage.sql): public read, each user writes only <uid>/… */
export const AVATAR_BUCKET = 'avatars';
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const avatarPath = (uid: string) => `${uid}/avatar`;

/** A sentence for an upload problem (Storage errors are not shown raw). */
export function avatarError(e: unknown): string {
  const m = (e as { message?: string })?.message ?? '';
  if (/bucket not found/i.test(m)) return 'Photo uploads are not set up yet: the avatars storage bucket is missing (run the avatars migration).';
  if (/row-level security|unauthorized|403/i.test(m)) return 'You can only change your own photo. Sign in again and retry.';
  if (/too large|payload|size/i.test(m)) return 'That image is too large (2 MB at most).';
  return m && m.length < 160 ? m : 'The photo could not be uploaded. Try again.';
}

export function checkAvatarFile(f: File): string | null {
  if (!AVATAR_TYPES.includes(f.type)) return 'Use a PNG, JPEG, WebP or GIF image.';
  if (f.size > AVATAR_MAX_BYTES) return `That image is ${(f.size / 1048576).toFixed(1)} MB; 2 MB at most.`;
  return null;
}

/** Upload (or replace) the user's photo in Storage and save its public URL to profiles.avatar_url. */
export function useAvatar() {
  const qc = useQueryClient();
  const uid = useAuth((s) => s.session?.user.id ?? null);
  const done = (p: Profile) => {
    qc.setQueryData(['profile', p.id], p);
    void qc.invalidateQueries({ queryKey: ['community'] });   // author photos in the feed and comments
  };
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!supabase || !uid) throw new Error('Not signed in.');
      const bad = checkAvatarFile(file);
      if (bad) throw new Error(bad);
      const bucket = supabase.storage.from(AVATAR_BUCKET);
      const { error } = await bucket.upload(avatarPath(uid), file, { upsert: true, contentType: file.type, cacheControl: '3600' });
      if (error) throw error;
      // Same object path every time: the version parameter makes browsers and the CDN fetch the new image.
      const url = `${bucket.getPublicUrl(avatarPath(uid)).data.publicUrl}?v=${Date.now()}`;
      const { data, error: e2 } = await supabase.from('profiles').update({ avatar_url: url }).eq('id', uid).select().single();
      if (e2) throw e2;
      return data as Profile;
    },
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (!supabase || !uid) throw new Error('Not signed in.');
      await supabase.storage.from(AVATAR_BUCKET).remove([avatarPath(uid)]);   // nothing stored yet is fine
      const { data, error } = await supabase.from('profiles').update({ avatar_url: null }).eq('id', uid).select().single();
      if (error) throw error;
      return data as Profile;
    },
    onSuccess: done,
  });
  return { upload, remove };
}
