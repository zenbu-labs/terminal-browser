use crate::style::Style;
use crate::tree::{InputProps, NodeId, Props, Tree};

#[derive(Default)]
pub struct Desc {
    pub style: Style,
    pub text: Option<String>,
    pub key: Option<String>,
    pub clickable: bool,
    pub input: Option<InputProps>,
    pub content_height: Option<f32>,
    pub scroll_events: bool,
    pub children: Vec<Desc>,
}

impl Desc {
    pub(crate) fn props(&self) -> Props {
        Props {
            style: self.style.clone(),
            text: self.text.clone(),
            key: self.key.clone(),
            clickable: self.clickable,
            hidden: false,
            input: self.input.clone(),
            content_height: self.content_height,
            scroll_events: self.scroll_events,
        }
    }

    fn reusable(&self, tree: &Tree, id: NodeId) -> bool {
        tree.get(id)
            .is_some_and(|node| node.input.is_some() == self.input.is_some())
    }
}

impl Tree {
    pub fn reconcile(&mut self, desc: Desc) {
        crate::profiler::span("tree.reconcile", || {
            let root = self.root();
            let mut props = desc.props();
            if let Some(node) = self.get(root) {
                props.style.width = node.style.width;
                props.style.height = node.style.height;
            }
            self.update(root, props);
            self.reconcile_children(root, desc.children);
        });
    }

    fn reconcile_node(&mut self, id: NodeId, desc: Desc) {
        self.update(id, desc.props());
        self.reconcile_children(id, desc.children);
    }

    fn reconcile_children(&mut self, parent: NodeId, descs: Vec<Desc>) {
        let old = self.children(parent).to_vec();
        let mut used = vec![false; old.len()];
        let mut result: Vec<(NodeId, Desc)> = Vec::with_capacity(descs.len());

        for desc in descs {
            let found = match &desc.key {
                Some(key) => old.iter().enumerate().position(|(i, &c)| {
                    !used[i] && self.key_of(c) == Some(key.as_str()) && desc.reusable(self, c)
                }),
                None => old.iter().enumerate().position(|(i, &c)| {
                    !used[i] && self.key_of(c).is_none() && desc.reusable(self, c)
                }),
            };
            let id = match found {
                Some(i) => {
                    used[i] = true;
                    old[i]
                }
                None => self.create(desc.props()),
            };
            result.push((id, desc));
        }

        for (i, &id) in old.iter().enumerate() {
            if !used[i] {
                self.remove(id);
            }
        }

        let target: Vec<NodeId> = result.iter().map(|(id, _)| *id).collect();
        if self.children(parent) != target.as_slice() {
            for &id in &target {
                self.append(parent, id);
            }
        }

        for (id, desc) in result {
            self.reconcile_node(id, desc);
        }
    }
}
