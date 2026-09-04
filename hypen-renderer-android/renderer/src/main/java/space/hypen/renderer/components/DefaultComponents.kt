package space.hypen.renderer.components

/**
 * Registers all default Hypen components.
 */
fun ComponentRegistry.registerDefaults(): ComponentRegistry {
    // Root component
    register(AppComponent())

    // Layout components
    register(ColumnComponent())
    register(RowComponent())
    register(ListComponent())
    register(ContainerComponent())
    register(BoxComponent())
    register(CenterComponent())
    register(SpacerComponent())
    register(StackComponent())
    register(GridComponent())
    register(SafeAreaComponent())

    // Content components
    register(TextComponent())
    register(HeadingComponent())
    register(ParagraphComponent())
    register(ButtonComponent())
    register(ImageComponent())
    register(VideoComponent())
    register(AudioComponent())
    register(DividerComponent())

    // Form components
    register(InputComponent())
    register(TextAreaComponent())
    register(CheckboxComponent())
    register(SelectComponent())
    register(SliderComponent())
    register(SwitchComponent())

    // Media timeline for a Video `controls` slot (inert outside a Video)
    register(ScrubberComponent())

    // UI components
    register(CardComponent())
    register(SpinnerComponent())
    register(ProgressBarComponent())
    register(BadgeComponent())
    register(AvatarComponent())

    // Navigation components
    register(RouterComponent())
    register(RouteComponent())
    register(LinkComponent())

    // Icon component (renders server-resolved SVG path data)
    register(IconComponent())

    // Embedded remote app (HypenApp("ws://...")) with loading/error slots
    register(HypenAppComponent())

    return this
}

/**
 * Creates a new ComponentRegistry with all default components registered.
 */
fun createDefaultComponentRegistry(): ComponentRegistry = DefaultComponentRegistry().registerDefaults()
