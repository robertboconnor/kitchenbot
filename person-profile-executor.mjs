import { updatePersonProfile } from './db.mjs';

// ONE BRAIN: the brain decides what structured fact to record about a person and passes it;
// this executor just appends it to their profile. No side-model, no transcript scan.

function safeTrim(text) {
  return String(text ?? '').trim();
}

function toList(raw) {
  const source = Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw];
  return source.map((v) => safeTrim(v)).filter(Boolean);
}

export async function executePersonProfileUpdate(runtimeAction, context) {
  const input =
    runtimeAction?.input && typeof runtimeAction.input === 'object' && !Array.isArray(runtimeAction.input)
      ? runtimeAction.input
      : {};
  const person = safeTrim(input.person || input.name || input.who);
  if (!person) {
    return { capability: 'person.profile.update', status: 'invalid', error: 'Tell me which person this is about.' };
  }
  const acceptedFoods = toList(input.acceptedFoods || input.accepts || input.likes);
  const rejectedFoods = toList(input.rejectedFoods || input.rejects || input.dislikes);
  const allergies = toList(input.allergies || input.allergicTo);
  const notes = toList(input.notes ?? input.note);
  if (acceptedFoods.length + rejectedFoods.length + allergies.length + notes.length === 0) {
    return {
      capability: 'person.profile.update',
      status: 'invalid',
      person,
      error: 'Nothing to record — pass accepted/rejected foods, allergies, or a note.',
    };
  }
  const profile = await updatePersonProfile(context.req.householdId, person, {
    acceptedFoods,
    rejectedFoods,
    allergies,
    notes,
  });
  return {
    capability: 'person.profile.update',
    status: 'updated',
    changed: true,
    person: profile.person,
    acceptedFoods: profile.acceptedFoods,
    rejectedFoods: profile.rejectedFoods,
    allergies: profile.allergies,
    notes: profile.notes,
  };
}
