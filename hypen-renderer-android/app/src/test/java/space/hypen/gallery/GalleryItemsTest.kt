package space.hypen.gallery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GalleryItemsTest {
    @Test
    fun `find accepts display names and canonical deeplink segments`() {
        assertEquals("verticalAlignment", GalleryItems.find("verticalAlignment")?.name)
        assertEquals("verticalAlignment", GalleryItems.find("justifyContent")?.name)
        assertEquals("horizontalAlignment", GalleryItems.find("ALIGNITEMS")?.name)
        assertEquals("Badge", GalleryItems.find("badge")?.name)
    }

    @Test
    fun `find rejects unknown or empty identifiers`() {
        assertNull(GalleryItems.find("does-not-exist"))
        assertNull(GalleryItems.find("  "))
    }
}
