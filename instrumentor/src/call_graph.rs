use std::collections::{HashMap, HashSet};
use walrus::{ElementId, ExportId, FunctionId};

#[derive(Debug, Hash, PartialEq, Eq, Clone)]
pub enum FunctionUse {
    Call { caller: FunctionId },
    InElement { element: ElementId, index: usize },
    Export { export: ExportId },
}

#[derive(Debug, Default)]
pub struct CallGraph {
    // FIXME: Think more efficient data structure
    callee_to_uses: HashMap<FunctionId, HashSet<FunctionUse>>,
}

impl CallGraph {
    pub fn build_from(module: &walrus::Module) -> Self {
        let mut graph = CallGraph::default();

        // Collect direct calls
        for (func_id, func) in module.funcs.iter_local() {
            let mut collector = CallCollector {
                graph: &mut graph,
                func_id,
            };
            walrus::ir::dfs_in_order(&mut collector, func, func.entry_block());
        }

        // Collect indirect function table elements
        for element in module.elements.iter() {
            match &element.items {
                walrus::ElementItems::Functions(funcs) => {
                    for (index, member) in funcs.iter().enumerate() {
                        graph.add_use(
                            *member,
                            FunctionUse::InElement {
                                element: element.id(),
                                index,
                            },
                        );
                    }
                }
                walrus::ElementItems::Expressions(_, _) => {
                    unreachable!("expression in element segment is not supported yet")
                }
            }
        }

        // Collect exports having references to functions
        for export in module.exports.iter() {
            if let walrus::ExportItem::Function(func) = export.item {
                graph.add_use(
                    func,
                    FunctionUse::Export {
                        export: export.id(),
                    },
                )
            }
        }

        graph
    }

    pub fn get_func_uses(&self, func_id: &FunctionId) -> Option<&HashSet<FunctionUse>> {
        self.callee_to_uses.get(func_id)
    }

    pub fn add_use(&mut self, callee: FunctionId, use_entry: FunctionUse) {
        self.callee_to_uses
            .entry(callee)
            .or_default()
            .insert(use_entry);
    }
}

struct CallCollector<'graph> {
    func_id: FunctionId,
    graph: &'graph mut CallGraph,
}

impl<'instr> walrus::ir::Visitor<'instr> for CallCollector<'_> {
    fn visit_call(&mut self, instr: &walrus::ir::Call) {
        self.graph.add_use(
            instr.func,
            FunctionUse::Call {
                caller: self.func_id,
            },
        );
    }
}
