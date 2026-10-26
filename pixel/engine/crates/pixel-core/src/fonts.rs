use std::collections::HashMap;
use std::ops::Deref;
use std::sync::Arc;

pub type Face = Arc<fontdue::Font>;

pub const REGULAR: u16 = 400;
pub const BOLD: u16 = 700;
const BOLD_THRESHOLD: u16 = 600;

#[derive(Clone)]
pub struct Font {
    faces: Vec<Face>,
    id: usize,
    pub synthetic_bold: bool,
    pub synthetic_italic: bool,
    variants: [usize; 4],
}

static NEXT_ID: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn next_id() -> usize {
    NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

impl Font {
    pub fn single(face: fontdue::Font) -> Font {
        Font { faces: vec![Arc::new(face)], id: next_id(), synthetic_bold: false, synthetic_italic: false, variants: [0; 4] }
    }

    pub fn primary(&self) -> &fontdue::Font {
        &self.faces[0]
    }

    pub fn fallback_for(&self, ch: char) -> Option<&fontdue::Font> {
        self.faces[1..].iter().map(|face| face.as_ref()).find(|face| face.lookup_glyph_index(ch) != 0)
    }

    pub fn id(&self) -> usize {
        self.id
    }

    pub fn variant(&self, bold: bool, italic: bool) -> usize {
        self.variants[usize::from(bold) | usize::from(italic) << 1]
    }

    pub fn metrics(&self, ch: char, px: f32) -> fontdue::Metrics {
        self.primary().metrics(ch, px)
    }

    pub fn rasterize(&self, ch: char, px: f32) -> (fontdue::Metrics, Vec<u8>) {
        self.primary().rasterize(ch, px)
    }

    pub fn lookup_glyph_index(&self, ch: char) -> u16 {
        self.primary().lookup_glyph_index(ch)
    }

    pub fn horizontal_line_metrics(&self, px: f32) -> Option<fontdue::LineMetrics> {
        self.primary().horizontal_line_metrics(px)
    }
}

struct Registered {
    family: String,
    weight: u16,
    italic: bool,
    source: String,
    face: Face,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct StackKey {
    families: usize,
    weight: u16,
    italic: bool,
}

pub struct FontRegistry {
    faces: Vec<Registered>,
    family_lists: Vec<Vec<String>>,
    family_ids: HashMap<Vec<String>, usize>,
    stacks: Vec<Font>,
    interned: HashMap<StackKey, usize>,
}

pub const DEFAULT_FAMILIES: usize = 0;

pub const MONOSPACE: &str = "monospace";
pub const SANS_SERIF: &str = "sans-serif";
const GENERIC_ALIASES: [(&str, &str); 2] = [("system-ui", SANS_SERIF), ("ui-monospace", MONOSPACE)];

impl FontRegistry {
    pub fn new(monospace: fontdue::Font, sans_serif: fontdue::Font) -> Self {
        let mut registry = Self { faces: Vec::new(), family_lists: Vec::new(), family_ids: HashMap::new(), stacks: Vec::new(), interned: HashMap::new() };
        registry.add_face(MONOSPACE, REGULAR, false, monospace, "bundled:monospace");
        registry.add_face(SANS_SERIF, REGULAR, false, sans_serif, "bundled:sans-serif");
        registry.families(&[MONOSPACE.to_string()]);
        registry.resolve(DEFAULT_FAMILIES, REGULAR, false);
        registry
    }

    pub fn add_face(&mut self, family: &str, weight: u16, italic: bool, face: fontdue::Font, source: &str) -> bool {
        let family = normalize(family);
        if self.faces.iter().any(|r| r.family == family && r.weight == weight && r.italic == italic && r.source == source) {
            return false;
        }
        self.faces.push(Registered { family, weight, italic, source: source.to_string(), face: Arc::new(face) });
        let built: Vec<(StackKey, usize)> = self.interned.iter().map(|(&key, &base)| (key, base)).collect();
        for (key, base) in built {
            for (i, stack) in self.variant_stacks(key, base).into_iter().enumerate() {
                self.stacks[base + i] = stack;
            }
        }
        true
    }

    pub fn families(&mut self, names: &[String]) -> usize {
        let mut list: Vec<String> = names.iter().map(|f| normalize(f)).collect();
        if !list.iter().any(|f| f == MONOSPACE) {
            list.push(MONOSPACE.to_string());
        }
        if let Some(&id) = self.family_ids.get(&list) {
            return id;
        }
        self.family_lists.push(list.clone());
        self.family_ids.insert(list, self.family_lists.len() - 1);
        self.family_lists.len() - 1
    }

    pub fn resolve(&mut self, families: usize, weight: u16, italic: bool) -> usize {
        let families = families.min(self.family_lists.len() - 1);
        let key = StackKey { families, weight, italic };
        if let Some(&index) = self.interned.get(&key) {
            return index;
        }
        let base = self.stacks.len();
        let stacks = self.variant_stacks(key, base);
        self.stacks.extend(stacks);
        self.interned.insert(key, base);
        base
    }

    fn variant_stacks(&self, key: StackKey, base: usize) -> [Font; 4] {
        let names = &self.family_lists[key.families];
        let variants = [base, base + 1, base + 2, base + 3];
        let StackKey { weight, italic, .. } = key;
        [(weight, italic), (weight.max(BOLD), italic), (weight, true), (weight.max(BOLD), true)]
            .map(|(variant_weight, variant_italic)| self.build(names, variant_weight, variant_italic, variants))
    }

    fn build(&self, families: &[String], weight: u16, italic: bool, variants: [usize; 4]) -> Font {
        let picked: Vec<&Registered> = families.iter().filter_map(|family| self.best(family, weight, italic)).collect();
        let primary = picked.first().copied();
        Font {
            faces: picked.iter().map(|r| r.face.clone()).collect(),
            id: next_id(),
            synthetic_bold: weight >= BOLD_THRESHOLD && primary.is_some_and(|r| r.weight < BOLD_THRESHOLD),
            synthetic_italic: italic && primary.is_some_and(|r| !r.italic),
            variants,
        }
    }

    fn best(&self, family: &str, weight: u16, italic: bool) -> Option<&Registered> {
        self.faces
            .iter()
            .rev()
            .filter(|r| r.family == family)
            .min_by_key(|r| (u32::from(r.italic != italic), weight_preference(weight, r.weight)))
    }
}

#[cfg(test)]
impl FontRegistry {
    pub fn bundled() -> Self {
        let face = |bytes: &[u8]| fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default()).unwrap();
        Self::new(
            face(include_bytes!("../../../assets/fonts/JetBrainsMono-Regular.ttf")),
            face(include_bytes!("../../../assets/fonts/InterVariable.ttf")),
        )
    }
}

impl Deref for FontRegistry {
    type Target = [Font];

    fn deref(&self) -> &[Font] {
        &self.stacks
    }
}

fn weight_preference(wanted: u16, face: u16) -> (u8, u16) {
    let distance = wanted.abs_diff(face);
    if face == wanted {
        return (0, 0);
    }
    match wanted {
        400..=500 if face > wanted && face <= 500 => (1, distance),
        400..=500 if face < wanted => (2, distance),
        400..=500 => (3, distance),
        _ if wanted < 400 => (if face < wanted { 1 } else { 2 }, distance),
        _ => (if face > wanted { 1 } else { 2 }, distance),
    }
}

fn normalize(family: &str) -> String {
    let lower = family.trim().to_lowercase();
    GENERIC_ALIASES.iter().find(|(alias, _)| *alias == lower).map_or(lower, |(_, generic)| generic.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONO: &[u8] = include_bytes!("../../../assets/fonts/JetBrainsMono-Regular.ttf");
    const SANS: &[u8] = include_bytes!("../../../assets/fonts/InterVariable.ttf");

    fn face(bytes: &[u8]) -> fontdue::Font {
        fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default()).unwrap()
    }

    fn registry() -> FontRegistry {
        FontRegistry::new(face(MONO), face(SANS))
    }

    #[test]
    fn the_default_stack_is_index_zero_and_monospace() {
        let mut fonts = registry();
        assert_eq!({ let f = fonts.families(&[MONOSPACE.into()]); fonts.resolve(f, REGULAR, false) }, 0);
        assert_eq!(fonts[0].faces.len(), 1);
        assert!(!fonts[0].synthetic_bold);
    }

    #[test]
    fn a_named_family_comes_first_and_monospace_ends_the_stack() {
        let mut fonts = registry();
        let index = { let f = fonts.families(&["Sans-Serif".into()]); fonts.resolve(f, REGULAR, false) };
        assert_eq!(fonts[index].faces.len(), 2);
        assert!(Arc::ptr_eq(&fonts[index].faces[0], &fonts.faces[1].face));
        assert!(Arc::ptr_eq(&fonts[index].faces[1], &fonts.faces[0].face));
    }

    #[test]
    fn an_unregistered_family_falls_through_to_monospace() {
        let mut fonts = registry();
        let index = { let f = fonts.families(&["Nonexistent".into()]); fonts.resolve(f, REGULAR, false) };
        assert!(Arc::ptr_eq(&fonts[index].faces[0], &fonts.faces[0].face));
    }

    #[test]
    fn bold_uses_a_bold_face_when_registered_and_emboldens_otherwise() {
        let mut fonts = registry();
        let plain = { let f = fonts.families(&[MONOSPACE.into()]); fonts.resolve(f, REGULAR, false) };
        assert!(fonts[fonts[plain].variant(true, false)].synthetic_bold);
        fonts.add_face(MONOSPACE, BOLD, false, face(MONO), "test:bold");
        let plain = { let f = fonts.families(&[MONOSPACE.into()]); fonts.resolve(f, REGULAR, false) };
        let bold = fonts[plain].variant(true, false);
        assert!(!fonts[bold].synthetic_bold);
        assert!(Arc::ptr_eq(&fonts[bold].faces[0], &fonts.faces[2].face));
    }

    #[test]
    fn italic_is_synthetic_until_an_italic_face_exists() {
        let mut fonts = registry();
        let plain = { let f = fonts.families(&[MONOSPACE.into()]); fonts.resolve(f, REGULAR, false) };
        assert!(fonts[fonts[plain].variant(false, true)].synthetic_italic);
    }

    #[test]
    fn generic_aliases_name_the_same_faces() {
        let mut fonts = registry();
        let ui = { let f = fonts.families(&["system-ui".into()]); fonts.resolve(f, REGULAR, false) };
        assert!(Arc::ptr_eq(&fonts[ui].faces[0], &fonts.faces[1].face));
    }

    #[test]
    fn registering_a_face_rebuilds_stacks_in_place() {
        let mut fonts = registry();
        let index = { let f = fonts.families(&[MONOSPACE.into()]); fonts.resolve(f, REGULAR, false) };
        let before = fonts[fonts[index].variant(true, false)].id();
        assert!(fonts.add_face(MONOSPACE, BOLD, false, face(MONO), "test:bold"));
        let bold = fonts[index].variant(true, false);
        assert!(!fonts[bold].synthetic_bold, "the existing bold variant picked up the new face");
        assert_ne!(fonts[bold].id(), before);
        assert!(!fonts.add_face(MONOSPACE, BOLD, false, face(MONO), "test:bold"), "the same file twice is ignored");
    }

    #[test]
    fn a_face_registered_later_wins_a_tie() {
        let mut fonts = registry();
        fonts.add_face(MONOSPACE, REGULAR, false, face(SANS), "test:custom");
        let index = { let f = fonts.families(&[MONOSPACE.into()]); fonts.resolve(f, REGULAR, false) };
        assert!(Arc::ptr_eq(&fonts[index].faces[0], &fonts.faces[2].face));
    }

    #[test]
    fn missing_weights_fall_back_in_css_order() {
        assert!(weight_preference(400, 500) < weight_preference(400, 300));
        assert!(weight_preference(400, 300) < weight_preference(400, 600));
        assert!(weight_preference(500, 400) < weight_preference(500, 600));
        assert!(weight_preference(300, 200) < weight_preference(300, 400));
        assert!(weight_preference(700, 800) < weight_preference(700, 600));
    }
}
