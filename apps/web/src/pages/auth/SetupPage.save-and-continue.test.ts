import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BreakDef, SetupStatus, ShiftDef } from '@fld/shared';

// The web tests have no DOM library, so the wizard runs on a tiny hook runtime instead of React (as in
// the useTvState tests): each mounted component keeps its own state slots, setters write to them and
// effects run once after its first render. Rendering is calling the component; pressing a button is
// calling the form's submit handler with the event the browser would send.
type Instance = { slots: unknown[]; idx: number; effects: Array<() => unknown> };
const runtime = vi.hoisted(() => ({ current: null as Instance | null }));
const world = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  saving: new Set<Promise<void>>(),
}));
const ds = vi.hoisted(() => ({
  createShift: vi.fn(async (v: unknown) => v),
  createBreak: vi.fn(async (v: unknown) => v),
}));

vi.mock('react', async (importOriginal) => {
  const slot = <T>(make: () => T): { v: T } => {
    const inst = runtime.current!;
    const i = inst.idx++;
    if (!(i in inst.slots)) inst.slots[i] = { v: make() };
    return inst.slots[i] as { v: T };
  };
  return {
    ...(await importOriginal<typeof import('react')>()),
    useState: (init: unknown) => {
      const s = slot(() => (typeof init === 'function' ? (init as () => unknown)() : init));
      const set = (next: unknown) => {
        s.v = typeof next === 'function' ? (next as (prev: unknown) => unknown)(s.v) : next;
      };
      return [s.v, set];
    },
    useRef: (init: unknown) => slot(() => ({ current: init })).v,
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => unknown) => {
      const inst = runtime.current!;
      slot(() => inst.effects.push(fn));
    },
  };
});
vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: world.queries[queryKey[0]],
    isLoading: false,
    isError: false,
    error: null,
  }),
  useQueryClient: () => ({ invalidateQueries: () => undefined }),
  useMutation: (opts: { mutationFn: (v: unknown) => Promise<unknown>; onSuccess?: () => void }) => ({
    isPending: world.saving.size > 0,
    error: null,
    // As TanStack does: the hook's onSuccess, then the one passed to this mutate() call.
    mutate: (v: unknown, call?: { onSuccess?: () => void }) => {
      const p = opts.mutationFn(v).then(() => {
        opts.onSuccess?.();
        call?.onSuccess?.();
        world.saving.delete(p);
      });
      world.saving.add(p);
    },
  }),
}));
vi.mock('react-router-dom', () => ({
  Navigate: () => null,
  useNavigate: () => () => undefined,
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'admin', role: 'admin' }, loading: false, needsSetup: false }),
  hasRole: () => true,
}));
vi.mock('../../data', () => ({ IS_MOCK: false }));
vi.mock('../../data/DataSourceContext', () => ({ useDataSource: () => ds }));
vi.mock('../../lib/usePlantTz', () => ({ usePlantTz: () => 'UTC', browserTz: () => 'UTC' }));

const { SetupPage } = await import('./SetupPage');
const { ShiftForm } = await import('../admin/components/ShiftForm');
const { BreakForm } = await import('../admin/components/BreakForm');

type El = { type: unknown; props: { children?: unknown; [k: string]: unknown } };
type Handler = (e: unknown) => void;

const mount = (): Instance => ({ slots: [], idx: 0, effects: [] });

function render(inst: Instance, el: El): El {
  const prev = runtime.current;
  runtime.current = inst;
  inst.idx = 0;
  try {
    const tree = (el.type as (props: unknown) => El)(el.props);
    for (const fn of inst.effects.splice(0)) fn();
    return tree;
  } finally {
    runtime.current = prev;
  }
}

function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) for (const n of node) elements(n, out);
  else if (node && typeof node === 'object' && 'props' in node) {
    out.push(node as El);
    elements((node as El).props.children, out);
  }
  return out;
}

function find(tree: El, pred: (el: El) => boolean): El {
  const el = elements(tree).find(pred);
  if (!el) throw new Error('element not found');
  return el;
}

// What the browser hands the form's submit handler: the button pressed, and whether it is inside the <form>.
const footerButton = { label: 'Save and continue' };
const ownButton = { label: 'Add shift / Add break' };
const pressed = (button: object) => ({
  preventDefault: () => undefined,
  nativeEvent: { submitter: button },
  currentTarget: { contains: (node: unknown) => node === ownButton },
});

/** Opens the wizard on its first step still to do, with that step's shift or break form. */
function openWizard() {
  const page = mount();
  const pageTree = () => render(page, { type: SetupPage, props: {} });
  pageTree(); // the mount effect moves to the first step still to do
  const tree = pageTree();

  const step = mount();
  const body = find(tree, (e) => e.props.className === 'setup-body');
  const stepEl = elements(body.props.children)[0]!; // only the current step renders
  // The step's latest form element, as React would pass it after the step re-renders.
  const formEl = () => find(render(step, stepEl), (e) => e.type === ShiftForm || e.type === BreakForm);
  const form = mount();
  const formTree = () => render(form, formEl());
  const field = (label: string) => find(formTree(), (e) => e.props.label === label);

  return {
    footer: find(tree, (e) => e.props.children === 'Save and continue'),
    formId: formEl().props.id,
    title: () => find(pageTree(), (e) => e.type === 'h2').props.children,
    field,
    type: (label: string, value: string) =>
      (find(field(label), (e) => typeof e.props.onChange === 'function').props.onChange as Handler)({
        currentTarget: { value },
      }),
    press: (button: object) => (find(formTree(), (e) => e.type === 'form').props.onSubmit as Handler)(pressed(button)),
  };
}

const saved = () => Promise.all([...world.saving]);

const status = (done: Partial<SetupStatus['steps']>): SetupStatus => ({
  needs_setup: false,
  steps: { admin_user: true, timezone: true, connection: true, mapping: true, shifts: false, breaks: false, backfill: false, ...done },
});

const dayShift: ShiftDef = {
  id: 1,
  name: 'Day',
  start_local: '06:00',
  end_local: '14:30',
  days_of_week: [1, 2, 3, 4, 5],
  effective_from: '2026-01-01',
  effective_to: null,
};

beforeEach(() => {
  world.saving.clear();
  ds.createShift.mockClear();
  ds.createBreak.mockClear();
});

describe('setup wizard: "Save and continue" on the Shifts step', () => {
  beforeEach(() => {
    world.queries = { setupStatus: status({}), shifts: [], breaks: [] };
  });

  it('submits the shift form', () => {
    const w = openWizard();
    expect(w.title()).toBe('Shifts');
    expect(w.formId).toBeTruthy();
    expect(w.footer.props.type).toBe('submit');
    expect(w.footer.props.form).toBe(w.formId);
  });

  it('saves the shift being typed, then moves on', async () => {
    const w = openWizard();
    w.type('Name', 'Day');
    w.type('Start (plant local)', '06:00');
    w.type('End (plant local)', '14:30');
    w.press(footerButton);
    await saved();

    expect(ds.createShift).toHaveBeenCalledTimes(1);
    expect(ds.createShift).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Day', start_local: '06:00', end_local: '14:30', days_of_week: [0, 1, 2, 3, 4, 5, 6] }),
    );
    expect(w.title()).toBe('Breaks');
  });

  it('adds the shift once when pressed again while it saves', async () => {
    const w = openWizard();
    w.type('Name', 'Day');
    w.press(footerButton);
    w.press(footerButton);
    await saved();

    expect(ds.createShift).toHaveBeenCalledTimes(1);
    expect(w.title()).toBe('Breaks');
  });

  it('leaves "Add shift" on the step for the next shift', async () => {
    const w = openWizard();
    w.type('Name', 'Day');
    w.press(ownButton);
    await saved();

    expect(ds.createShift).toHaveBeenCalledTimes(1);
    expect(w.title()).toBe('Shifts');
  });

  it('moves on without saving when nothing was typed and a shift exists', () => {
    world.queries.shifts = [dayShift];
    const w = openWizard();
    w.press(footerButton);

    expect(ds.createShift).not.toHaveBeenCalled();
    expect(w.title()).toBe('Breaks');
  });

  it('stays and says what the form needs when nothing was typed and no shift exists', () => {
    const w = openWizard();
    w.press(footerButton);

    expect(ds.createShift).not.toHaveBeenCalled();
    expect(w.title()).toBe('Shifts');
    expect(w.field('Name').props.error).toBe('Required');
  });
});

describe('setup wizard: "Save and continue" on the Breaks step', () => {
  beforeEach(() => {
    world.queries = { setupStatus: status({ shifts: true }), shifts: [dayShift], breaks: [] };
  });

  it('saves the break being typed, then moves on', async () => {
    const w = openWizard();
    expect(w.title()).toBe('Breaks');
    expect(w.formId).toBeTruthy();
    expect(w.footer.props.type).toBe('submit');
    expect(w.footer.props.form).toBe(w.formId);

    w.type('Name', 'Lunch');
    w.type('Duration (minutes)', '30');
    w.press(footerButton);
    await saved();

    expect(ds.createBreak).toHaveBeenCalledTimes(1);
    expect(ds.createBreak).toHaveBeenCalledWith(expect.objectContaining({ name: 'Lunch', duration_minutes: 30, shift_ids: null }));
    expect(w.title()).toBe('Historical backfill');
  });

  it('moves on without saving when nothing was typed and a break exists', () => {
    const lunch: BreakDef = {
      id: 1,
      name: 'Lunch',
      start_local: '12:00',
      duration_minutes: 30,
      days_of_week: [1, 2, 3, 4, 5],
      shift_ids: null,
      effective_from: '2026-01-01',
      effective_to: null,
    };
    world.queries.breaks = [lunch];
    const w = openWizard();
    w.press(footerButton);

    expect(ds.createBreak).not.toHaveBeenCalled();
    expect(w.title()).toBe('Historical backfill');
  });
});
