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

static NEXT_STANDALONE_ID: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(1 << 32);

impl Font {
    pub fn single(face: fontdue::Font) -> Font {
        let id = NEXT_STANDALONE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Font { faces: vec![Arc::new(face)], id, synthetic_bold: false, synthetic_italic: false, variants: [0; 4] }
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
        registry.add_face(MONOSPACE, REGULAR, false, monospace);
        registry.add_face(SANS_SERIF, REGULAR, false, sans_serif);
        registry.families(&[MONOSPACE.to_string()]);
        registry.resolve(DEFAULT_FAMILIES, REGULAR, false);
        registry
    }

    pub fn add_face(&mut self, family: &str, weight: u16, italic: bool, face: fontdue::Font) {
        self.faces.push(Registered { family: normalize(family), weight, italic, face: Arc::new(face) });
        self.interned.clear();
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
        let variants = [base, base + 1, base + 2, base + 3];
        let names = self.family_lists[families].clone();
        for (i, (variant_weight, variant_italic)) in [(weight, italic), (weight.max(BOLD), italic), (weight, true), (weight.max(BOLD), true)].into_iter().enumerate() {
            let stack = self.build(&names, variant_weight, variant_italic, base + i, variants);
            self.stacks.push(stack);
        }
        self.interned.insert(key, base);
        base
    }

    fn build(&self, families: &[String], weight: u16, italic: bool, id: usize, variants: [usize; 4]) -> Font {
        let picked: Vec<&Registered> = families.iter().filter_map(|family| self.best(family, weight, italic)).collect();
        let primary = picked.first().copied();
        Font {
            faces: picked.iter().map(|r| r.face.clone()).collect(),
            id,
            synthetic_bold: weight >= BOLD_THRESHOLD && primary.is_some_and(|r| r.weight < BOLD_THRESHOLD),
            synthetic_italic: italic && primary.is_some_and(|r| !r.italic),
            variants,
        }
    }

    fn best(&self, family: &str, weight: u16, italic: bool) -> Option<&Registered> {
        self.faces
            .iter()
            .filter(|r| r.family == family)
            .min_by_key(|r| {
                let style_miss = u32::from(r.italic != italic);
                let distance = u32::from(r.weight.abs_diff(weight));
                let wrong_side = u32::from(if weight >= BOLD_THRESHOLD { r.weight < weight } else { r.weight > weight });
                (style_miss, wrong_side, distance)
            })
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
        fonts.add_face(MONOSPACE, BOLD, false, face(MONO));
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
}
