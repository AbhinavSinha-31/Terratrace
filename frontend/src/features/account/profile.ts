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
    mutationFn: async (patch: Pick<Profile, 'display_name'>) => {
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
