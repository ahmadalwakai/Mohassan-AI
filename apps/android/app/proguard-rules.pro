# kotlinx.serialization: keep the generated serializers of the app's own models.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.ahmadalwakai.wasla.**$$serializer { *; }
-keepclassmembers class com.ahmadalwakai.wasla.** { *** Companion; }
-keepclasseswithmembers class com.ahmadalwakai.wasla.** { kotlinx.serialization.KSerializer serializer(...); }
