//! Serialization for the Remote UI protocol.
//!
//! The Remote UI protocol allows the Hypen engine to run on a server while
//! a thin client renders the UI. See [`RemoteMessage`] for the wire format.

pub mod remote;

pub use remote::{InitialTree, PatchStream, RemoteMessage};
