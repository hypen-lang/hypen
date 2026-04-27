use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ops::Range;

/// Represents an argument passed to a component
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Argument {
    /// Positional argument with index and value
    Positioned { position: usize, value: Value },
    /// Named argument with key and value
    Named { key: String, value: Value },
}

/// Represents different value types in Hypen
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Value {
    String(String),
    Number(f64),
    Boolean(bool),
    List(Vec<Value>),
    Map(HashMap<String, Value>),
    Reference(String),           // e.g., @state.user, @actions.login, @spacetime.messages
    DataSourceReference(String), // DEPRECATED: use Reference instead. Kept for backward compat.
}

/// List of arguments for a component
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArgumentList {
    pub arguments: Vec<Argument>,
}

impl ArgumentList {
    pub fn new(arguments: Vec<Argument>) -> Self {
        Self { arguments }
    }

    pub fn empty() -> Self {
        Self { arguments: vec![] }
    }

    pub fn as_map(&self) -> HashMap<String, Value> {
        self.arguments
            .iter()
            .enumerate()
            .map(|(i, arg)| match arg {
                Argument::Positioned { value, .. } => (i.to_string(), value.clone()),
                Argument::Named { key, value } => (key.clone(), value.clone()),
            })
            .collect()
    }

    pub fn get_named(&self, key: &str) -> Option<&Value> {
        self.arguments.iter().find_map(|arg| match arg {
            Argument::Named { key: k, value } if k == key => Some(value),
            _ => None,
        })
    }

    pub fn get_positioned(&self, position: usize) -> Option<&Value> {
        self.arguments.iter().find_map(|arg| match arg {
            Argument::Positioned { position: p, value } if *p == position => Some(value),
            _ => None,
        })
    }
}

/// Metadata about a component's position in source text
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetaData {
    pub internal_id: String,
    pub name_range: Range<usize>,
    pub block_range: Option<Range<usize>>,
}

/// An applicator specification (style/modifier applied to a component)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApplicatorSpecification {
    pub name: String,
    pub arguments: ArgumentList,
    pub children: Vec<ComponentSpecification>,
    pub internal_id: String,
}

/// Declaration type for components
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum DeclarationType {
    /// Regular component: `ComponentName(...)`
    Component,
    /// Module declaration: `module ComponentName(...)`
    Module,
    /// Component declaration: `component ComponentName(...)`
    ComponentKeyword,
}

/// The main component specification representing a parsed component
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComponentSpecification {
    pub id: String,
    pub name: String,
    pub declaration_type: DeclarationType,
    pub arguments: ArgumentList,
    pub applicators: Vec<ApplicatorSpecification>,
    pub children: Vec<ComponentSpecification>,
    pub metadata: MetaData,
}

impl ComponentSpecification {
    pub fn new(
        id: String,
        name: String,
        arguments: ArgumentList,
        applicators: Vec<ApplicatorSpecification>,
        children: Vec<ComponentSpecification>,
        metadata: MetaData,
    ) -> Self {
        Self {
            id,
            name,
            declaration_type: DeclarationType::Component,
            arguments,
            applicators,
            children,
            metadata,
        }
    }

    pub fn with_declaration_type(mut self, declaration_type: DeclarationType) -> Self {
        self.declaration_type = declaration_type;
        self
    }

    /// Flatten the component tree into a list
    pub fn flatten(&self) -> Vec<ComponentSpecification> {
        let mut result = vec![self.clone()];
        for child in &self.children {
            result.extend(child.flatten());
        }
        result
    }

    /// Convert a component to an applicator (when it starts with '.')
    pub fn to_applicator(&self) -> ApplicatorSpecification {
        ApplicatorSpecification {
            name: self.name.trim_start_matches('.').to_string(),
            arguments: self.arguments.clone(),
            children: self.children.clone(),
            internal_id: self.metadata.internal_id.clone(),
        }
    }
}


/// Import clause specifying what to import
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ImportClause {
    /// Named imports: import { Button, Card } from "..."
    Named(Vec<String>),
    /// Default import: import HomePage from "..."
    Default(String),
}

/// Import source (local path or URL)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ImportSource {
    /// Local file path: "./components/ui"
    Local(String),
    /// Web URL: "https://cdn.example.com/..."
    Url(String),
}

/// Import statement
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImportStatement {
    /// What to import (named or default)
    pub clause: ImportClause,
    /// Where to import from (local path or URL)
    pub source: ImportSource,
}

impl ImportStatement {
    pub fn new(clause: ImportClause, source: ImportSource) -> Self {
        Self { clause, source }
    }

    /// Get the source path as a string
    pub fn source_path(&self) -> &str {
        match &self.source {
            ImportSource::Local(path) => path,
            ImportSource::Url(url) => url,
        }
    }

    /// Get the list of component names being imported
    pub fn imported_names(&self) -> Vec<String> {
        match &self.clause {
            ImportClause::Named(names) => names.clone(),
            ImportClause::Default(name) => vec![name.clone()],
        }
    }
}

/// A Hypen document consisting of imports and component definitions
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Document {
    /// Import statements at the top of the document
    pub imports: Vec<ImportStatement>,
    /// Component definitions
    pub components: Vec<ComponentSpecification>,
}

impl Document {
    pub fn new(imports: Vec<ImportStatement>, components: Vec<ComponentSpecification>) -> Self {
        Self {
            imports,
            components,
        }
    }

    pub fn empty() -> Self {
        Self {
            imports: vec![],
            components: vec![],
        }
    }
}
