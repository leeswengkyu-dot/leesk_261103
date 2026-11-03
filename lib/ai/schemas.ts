import { z } from 'zod';

const nstr = z.string().nullable().optional();
const nnum = z.number().nullable().optional();

export const T1Schema = z.object({
  relevant: z.boolean(),
  region: z.enum(['nk', 'me', 'ru_ua']).nullable().optional(),
  country: nstr,
  location_name: nstr,
  lat: nnum,
  lng: nnum,
  location_accuracy: z.enum(['exact', 'area', 'unknown']).default('unknown'),
  area_radius_km: nnum,
  event_type: z
    .enum(['missile_launch', 'nuclear', 'armed_clash', 'military_exercise', 'official_statement', 'diplomacy', 'sanctions', 'other'])
    .default('other'),
  occurred_at: nstr,
  is_party_claim: z.boolean().default(false),
  unit_or_person_location: z.boolean().default(false),
  summary: nstr,
});
export type T1 = z.infer<typeof T1Schema>;

export const T2Schema = z.object({
  statements: z.array(
    z.object({
      text: z.string().min(1),
      label: z.enum(['fact', 'analysis', 'estimate', 'party_claim', 'unverified']),
      source_numbers: z.array(z.number().int()).default([]),
      fact_suggested: z.boolean().default(false),
    }),
  ),
});
export type T2 = z.infer<typeof T2Schema>;

export const T3Schema = z.object({
  content_conflict: z.boolean(),
  conflict_items: z.array(z.object({ item: z.string(), detail: z.string() })).default([]),
  change_type: z.enum(['escalated', 'ended']).nullable().optional(),
});
export type T3 = z.infer<typeof T3Schema>;

const sentence = z.object({ text: z.string().min(1), statement_ids: z.array(z.string()).min(1) });
export const T4Schema = z.object({
  summary: z.array(sentence).default([]),
  regions: z
    .array(z.object({ region: z.enum(['nk', 'me', 'ru_ua']), sentences: z.array(sentence) }))
    .default([]),
  watch: z.array(sentence).default([]),
});
export type T4 = z.infer<typeof T4Schema>;

export const T5Schema = z.object({
  results: z.array(
    z.object({
      number: z.number().int(),
      verdict: z.enum(['same', 'different', 'unsure']),
      confidence: z.number().default(0.5),
      reason: z.string().default(''),
    }),
  ),
});
export type T5 = z.infer<typeof T5Schema>;
