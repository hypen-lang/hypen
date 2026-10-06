use hypen_parser::parse_component;

#[test]
fn responsive_food_grids_are_valid_hypen_documents() {
    let templates = [
        (
            "cloudflare HomePage",
            include_str!("../../examples/food-ordering/cloudflare/src/components/HomePage.hypen"),
        ),
        (
            "cloudflare Search",
            include_str!("../../examples/food-ordering/cloudflare/src/components/Search.hypen"),
        ),
        (
            "shared HomePage",
            include_str!("../../examples/food-ordering/components/HomePage/component.hypen"),
        ),
        (
            "shared Search",
            include_str!("../../examples/food-ordering/components/Search/component.hypen"),
        ),
    ];

    for (name, source) in templates {
        if let Err(errors) = parse_component(source) {
            panic!("{name} must parse after responsive Grid edits: {errors:#?}");
        }
    }
}
