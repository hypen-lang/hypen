package space.hypen.renderer.applicators

/**
 * Registers all default Hypen applicators.
 */
fun ApplicatorRegistry.registerDefaults(): ApplicatorRegistry {
    // Spacing
    register(PaddingApplicator())
    register(PaddingTopApplicator())
    register(PaddingBottomApplicator())
    register(PaddingLeftApplicator())
    register(PaddingRightApplicator())
    register(PaddingHorizontalApplicator())
    register(PaddingVerticalApplicator())
    register(MarginApplicator())
    register(MarginTopApplicator())
    register(MarginBottomApplicator())
    register(MarginLeftApplicator())
    register(MarginRightApplicator())
    register(MarginHorizontalApplicator())
    register(MarginVerticalApplicator())

    // Size
    register(WidthApplicator())
    register(HeightApplicator())
    register(MinWidthApplicator())
    register(MaxWidthApplicator())
    register(MinHeightApplicator())
    register(MaxHeightApplicator())
    register(SizeApplicator())
    register(FillMaxSizeApplicator())
    register(FillMaxWidthApplicator())
    register(FillMaxHeightApplicator())

    // Colors
    register(BackgroundColorApplicator())
    register(BackgroundApplicator())
    register(ForegroundColorApplicator())

    // Border
    register(BorderApplicator())
    register(BorderWidthApplicator())
    register(BorderColorApplicator())
    register(BorderSideWidthApplicator(BorderSide.TOP))
    register(BorderSideWidthApplicator(BorderSide.RIGHT))
    register(BorderSideWidthApplicator(BorderSide.BOTTOM))
    register(BorderSideWidthApplicator(BorderSide.LEFT))
    register(BorderStyleApplicator())
    register(BorderRadiusApplicator())
    register(CornerRadiusApplicator())

    // Layout
    register(WeightApplicator())
    register(FlexApplicator())
    register(FlexGrowApplicator())
    register(FlexShrinkApplicator())
    register(AspectRatioApplicator())
    register(OffsetApplicator())
    register(GapApplicator())
    register(RowGapApplicator())
    register(ColumnGapApplicator())
    register(ZIndexApplicator())

    // Visual Effects
    register(OpacityApplicator())
    register(VisibilityApplicator())
    register(ShadowApplicator())
    register(ElevationApplicator())
    register(BoxShadowApplicator())
    register(BlurApplicator())
    register(ClipToBoundsApplicator())

    // Transforms
    register(RotateApplicator())
    register(ScaleApplicator())
    register(ScaleXApplicator())
    register(ScaleYApplicator())
    register(TranslateXApplicator())
    register(TranslateYApplicator())
    register(TransformApplicator())

    // Backgrounds/Gradients
    register(LinearGradientApplicator())
    register(RadialGradientApplicator())
    register(ConicGradientApplicator())
    register(GradientApplicator())
    register(BackgroundImageApplicator())
    register(BackgroundSizeApplicator())
    register(BackgroundPositionApplicator())

    // Events
    register(OnClickApplicator())
    register(OnPressApplicator())
    register(OnLongClickApplicator())
    register(OnLongPressApplicator())
    register(OnFocusApplicator())
    register(OnBlurApplicator())

    // Content alignment (skipped on containers that resolve it themselves)
    register(AlignmentApplicator())
    register(JustifyContentApplicator())
    register(AlignItemsApplicator())
    register(HorizontalAlignmentApplicator())
    register(VerticalAlignmentApplicator())

    return this
}

/**
 * Creates a new ApplicatorRegistry with all default applicators registered.
 */
fun createDefaultApplicatorRegistry(): ApplicatorRegistry = DefaultApplicatorRegistry().registerDefaults()
